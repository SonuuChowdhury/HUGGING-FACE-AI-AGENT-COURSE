import axios from "axios";
import dotenv from "dotenv";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";

dotenv.config();

// =================================================================
// CONFIG
// =================================================================
const BASE_URL = "https://agents-course-unit4-scoring.hf.space";

const keys = process.env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
let keyIndex = 0;

function getNextKey() {
  const key = keys[keyIndex];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// =================================================================
// SYSTEM PROMPT
// =================================================================
const SYSTEM_PROMPT = `You are a precise question-answering AI competing in the GAIA benchmark.

CRITICAL RULES:
1. Output ONLY the final answer — no explanation, no preamble, no "The answer is..."
2. Match the EXACT format GAIA expects:
   - Numbers: digits only (e.g. "42" not "forty-two"), unless text is clearly needed
   - Lists: comma-separated with exactly one space after each comma (e.g. "alpha, beta, gamma")
   - Names: exact spelling with correct capitalization (e.g. "Marie Curie", "iPhone", "NASA")
   - Dates: match the format implied by the question (e.g. "March 15, 1990" or "1990-03-15")
   - Currency: include symbol if asked (e.g. "$42.50")
3. If the question asks "how many" → give a number
4. If it asks for a name → give the name only
5. If it asks for a list → give items separated by ", "
6. Never say "I don't know" — give your best specific answer
7. Do NOT include "FINAL ANSWER" in your response
8. Use the available tools whenever you need web search or file access`;

// =================================================================
// MODEL FACTORY  (rotates keys, retries on 429)
// =================================================================
function makeLLM(withTools = true) {
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    apiKey: getNextKey(),
    maxRetries: keys.length * 2,
    temperature: 0,
  });
  return withTools ? llm : llm;
}

// =================================================================
// TOOLS
// =================================================================

// --- Web search via Tavily (free tier: 1000 calls/month) ----------
// Falls back to DuckDuckGo scrape if TAVILY_API_KEY not set
const webSearchTool = tool(
  async ({ query }) => {
    // Try Tavily first
    if (process.env.TAVILY_API_KEY) {
      try {
        const res = await axios.post(
          "https://api.tavily.com/search",
          { query, max_results: 5, search_depth: "basic" },
          { headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, timeout: 10000 }
        );
        const snippets = res.data.results
          .map((r) => `[${r.title}]\n${r.content}`)
          .join("\n\n");
        return snippets || "No results found.";
      } catch (e) {
        console.log("  ⚠️  Tavily error:", e.message);
      }
    }

    // Fallback: DuckDuckGo instant answer API
    try {
      const res = await axios.get("https://api.duckduckgo.com/", {
        params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
        timeout: 8000,
      });
      const d = res.data;
      const parts = [
        d.AbstractText,
        d.Answer,
        ...(d.RelatedTopics || []).slice(0, 3).map((t) => t.Text),
      ].filter(Boolean);
      return parts.join("\n\n") || "No results found.";
    } catch (e) {
      return `Search failed: ${e.message}`;
    }
  },
  {
    name: "web_search",
    description:
      "Search the web for factual information. Use this for any question requiring current data, specific facts, names, dates, or anything you are not 100% certain about.",
    schema: z.object({
      query: z.string().describe("A concise, specific search query (3-8 words)"),
    }),
  }
);

// --- File fetcher tool -------------------------------------------
const fetchFileTool = tool(
  async ({ task_id }) => {
    try {
      const res = await axios.get(`${BASE_URL}/files/${task_id}`, {
        responseType: "arraybuffer",
        timeout: 15000,
      });

      const contentType = res.headers["content-type"] || "";
      const buffer = Buffer.from(res.data);

      if (
        contentType.includes("text") ||
        contentType.includes("json") ||
        contentType.includes("csv") ||
        contentType.includes("html")
      ) {
        return buffer.toString("utf-8").slice(0, 6000);
      }

      if (
        contentType.includes("spreadsheet") ||
        contentType.includes("excel") ||
        contentType.includes("xlsx") ||
        contentType.includes("xls")
      ) {
        return `[Excel file detected — base64 encoded]\n${buffer.toString("base64").slice(0, 3000)}`;
      }

      if (contentType.includes("pdf")) {
        return `[PDF file detected — base64 encoded]\n${buffer.toString("base64").slice(0, 3000)}`;
      }

      if (contentType.includes("image")) {
        // Return as a special marker — the node handles image inline data
        return `__IMAGE__::${contentType.split(";")[0].trim()}::${buffer.toString("base64")}`;
      }

      return `[Binary file: ${contentType}]`;
    } catch (err) {
      if (err.response?.status === 404) return "No file attached to this task.";
      return `File fetch error: ${err.message}`;
    }
  },
  {
    name: "fetch_file",
    description:
      "Download the file attached to a GAIA task. Call this when the question references a file, attachment, spreadsheet, image, or document.",
    schema: z.object({
      task_id: z.string().describe("The GAIA task_id to fetch the file for"),
    }),
  }
);

// --- Math / calculator tool -------------------------------------
const calculatorTool = tool(
  async ({ expression }) => {
    try {
      // Safe eval: only allow math characters
      if (!/^[\d\s\+\-\*\/\.\(\)\%\^]+$/.test(expression)) {
        return "Invalid expression (only basic math allowed)";
      }
      // Use Function instead of eval for slight safety
      const result = new Function(`"use strict"; return (${expression})`)();
      return String(result);
    } catch (e) {
      return `Calculation error: ${e.message}`;
    }
  },
  {
    name: "calculator",
    description:
      "Evaluate a mathematical expression. Use for arithmetic, percentages, unit conversions. Input must be a valid JS math expression string.",
    schema: z.object({
      expression: z
        .string()
        .describe("Math expression to evaluate, e.g. '(42 * 3) / 7' or '100 * 0.15'"),
    }),
  }
);

const ALL_TOOLS = [webSearchTool, fetchFileTool, calculatorTool];

// =================================================================
// LANGGRAPH STATE
// =================================================================
const AgentState = Annotation.Root({
  // Inputs
  question: Annotation({ reducer: (a, b) => b ?? a }),
  task_id: Annotation({ reducer: (a, b) => b ?? a }),

  // Message history (standard LangGraph pattern)
  messages: Annotation({
    reducer: (existing, newMsgs) => [...existing, ...newMsgs],
    default: () => [],
  }),

  // Outputs
  firstAnswer: Annotation({ reducer: (a, b) => b ?? a, default: () => "" }),
  finalAnswer: Annotation({ reducer: (a, b) => b ?? a, default: () => "" }),

  // Loop control
  reflectDone: Annotation({ reducer: (a, b) => b ?? a, default: () => false }),
});

// =================================================================
// HELPER: normalise answer
// =================================================================
function normalizeAnswer(ans) {
  if (!ans) return "";
  ans = ans.trim();
  ans = ans.replace(/^["'](.+)["']$/, "$1").trim();

  const failPhrases = [
    /^(i (don't|cannot|can't)|unable to|not available|n\/a)/i,
    /^(i need|i would need|please provide|attachment|file not)/i,
  ];
  if (failPhrases.some((r) => r.test(ans))) return "";

  ans = ans.replace(/\s+/g, " ").trim();
  ans = ans.replace(/\.$/, "").trim();
  return ans;
}

// =================================================================
// HELPER: extract clean answer from raw LLM text
// =================================================================
function extractAnswer(raw) {
  if (!raw) return "";
  // Strip <thinking>...</thinking> block
  let text = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  // Also handle if model uses </thinking> without opening tag
  const afterThinking = text.match(/<\/thinking>\s*([\s\S]+)$/i);
  if (afterThinking) text = afterThinking[1].trim();
  // Take last non-empty line (model often puts final answer last)
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return normalizeAnswer(lines[lines.length - 1] || text);
}

// =================================================================
// NODE 1 — think_and_call
// Builds the initial message, calls LLM with tools bound
// =================================================================
async function thinkAndCallNode(state) {
  console.log("  🧠 [think_and_call] Reasoning with tools...");

  const llm = makeLLM();
  const llmWithTools = llm.bindTools(ALL_TOOLS);

  const userContent = `${SYSTEM_PROMPT}

Reason step by step inside a <thinking> block. Use tools (web_search, fetch_file, calculator) whenever needed to find the answer. After reasoning, output ONLY the final answer on its own line.

TASK ID: ${state.task_id}
QUESTION: ${state.question}`;

  const messages = [new HumanMessage(userContent)];

  let response;
  let retries = 0;
  while (true) {
    try {
      response = await llmWithTools.invoke(messages);
      break;
    } catch (err) {
      if ((err.status === 429 || err.status === 503) && retries < keys.length * 2) {
        retries++;
        console.log(`  ⚠️  Rate limited → retry ${retries}`);
        await sleep(2000 * retries);
      } else if (retries < 3) {
        retries++;
        await sleep(5000);
      } else {
        throw err;
      }
    }
  }

  return { messages: [response] };
}

// =================================================================
// NODE 2 — tool_executor  (ToolNode handles tool calls automatically)
// =================================================================
const toolNode = new ToolNode(ALL_TOOLS);

// =================================================================
// NODE 3 — extract_answer
// Reads message history, pulls the final text answer out
// =================================================================
async function extractAnswerNode(state) {
  console.log("  📝 [extract_answer] Extracting answer from messages...");

  // Walk messages in reverse to find the last AI text response
  const msgs = [...state.messages].reverse();
  let rawAnswer = "";

  for (const msg of msgs) {
    if (msg instanceof AIMessage && typeof msg.content === "string" && msg.content.trim()) {
      rawAnswer = msg.content;
      break;
    }
    if (msg instanceof AIMessage && Array.isArray(msg.content)) {
      const textBlock = msg.content.find((b) => b.type === "text" && b.text?.trim());
      if (textBlock) {
        rawAnswer = textBlock.text;
        break;
      }
    }
  }

  const firstAnswer = extractAnswer(rawAnswer);
  console.log(`  💬 First answer: "${firstAnswer}"`);

  return { firstAnswer };
}

// =================================================================
// NODE 4 — reflect
// Second LLM call to verify / improve the answer
// =================================================================
async function reflectNode(state) {
  console.log("  🔄 [reflect] Verifying answer...");

  if (!state.firstAnswer) {
    return { finalAnswer: "", reflectDone: true };
  }

  const llm = makeLLM();
  const llmWithTools = llm.bindTools(ALL_TOOLS);

  const userContent = `${SYSTEM_PROMPT}

A previous reasoning pass answered this question as: "${state.firstAnswer}"

Your job: verify this answer is correct and properly formatted.
- If correct → output the same answer (possibly lightly cleaned)
- If wrong or uncertain → use web_search to verify, then output the correct answer

Watch for these GAIA traps:
- Question asks for the LAST item (not the first)
- Question asks for a specific column value from a table
- Wrong number format (digits vs words)
- Wrong capitalisation

Output ONLY the final answer — nothing else.

TASK ID: ${state.task_id}
QUESTION: ${state.question}`;

  const messages = [new HumanMessage(userContent)];

  let response;
  let retries = 0;
  while (true) {
    try {
      response = await llmWithTools.invoke(messages);
      break;
    } catch (err) {
      if ((err.status === 429 || err.status === 503) && retries < keys.length * 2) {
        retries++;
        console.log(`  ⚠️  Rate limited → retry ${retries}`);
        await sleep(2000 * retries);
      } else if (retries < 3) {
        retries++;
        await sleep(5000);
      } else {
        throw err;
      }
    }
  }

  // Handle tool calls in reflection too
  let finalMessages = [response];
  let currentMsg = response;

  while (currentMsg.tool_calls && currentMsg.tool_calls.length > 0) {
    // Execute tools
    const toolResults = await toolNode.invoke({ messages: [currentMsg] });
    finalMessages = [...finalMessages, ...toolResults.messages];

    // Continue with tool results
    const allMsgs = [new HumanMessage(userContent), ...finalMessages];
    const nextResponse = await llmWithTools.invoke(allMsgs);
    finalMessages.push(nextResponse);
    currentMsg = nextResponse;
  }

  // Extract answer from last response
  let rawFinal = "";
  if (typeof currentMsg.content === "string") {
    rawFinal = currentMsg.content;
  } else if (Array.isArray(currentMsg.content)) {
    const tb = currentMsg.content.find((b) => b.type === "text");
    rawFinal = tb?.text || "";
  }

  const finalAnswer = extractAnswer(rawFinal) || state.firstAnswer;
  console.log(`  ✅ Final answer: "${finalAnswer}"`);

  return { finalAnswer, reflectDone: true };
}

// =================================================================
// CONDITIONAL EDGE — should_use_tools
// After think_and_call: if model called tools → go to tool_executor
// Otherwise → go straight to extract_answer
// =================================================================
function shouldUseTools(state) {
  const messages = state.messages;
  const lastMsg = messages[messages.length - 1];

  if (lastMsg instanceof AIMessage && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
    console.log(`  🔧 Tool calls: ${lastMsg.tool_calls.map((t) => t.name).join(", ")}`);
    return "tool_executor";
  }
  return "extract_answer";
}

// =================================================================
// CONDITIONAL EDGE — after_tools
// After tools run: go back to think_and_call so LLM can use results
// But cap at reasonable loop depth
// =================================================================
function afterTools(state) {
  // Count how many ToolMessages we've accumulated
  const toolMsgCount = state.messages.filter((m) => m instanceof ToolMessage).length;
  if (toolMsgCount >= 6) {
    // Safety: stop looping after 6 tool calls total
    console.log("  ⚠️  Tool call limit reached → extracting answer");
    return "extract_answer";
  }
  return "continue_reasoning";
}

// =================================================================
// NODE 5 — continue_reasoning
// After tools have run: give results back to LLM to keep going
// =================================================================
async function continueReasoningNode(state) {
  console.log("  🔁 [continue_reasoning] Processing tool results...");

  const llm = makeLLM();
  const llmWithTools = llm.bindTools(ALL_TOOLS);

  let retries = 0;
  let response;
  while (true) {
    try {
      response = await llmWithTools.invoke(state.messages);
      break;
    } catch (err) {
      if ((err.status === 429 || err.status === 503) && retries < keys.length * 2) {
        retries++;
        await sleep(2000 * retries);
      } else if (retries < 3) {
        retries++;
        await sleep(5000);
      } else {
        throw err;
      }
    }
  }

  return { messages: [response] };
}

// =================================================================
// BUILD GRAPH
// =================================================================
function buildGraph() {
  const graph = new StateGraph(AgentState)
    // Nodes
    .addNode("think_and_call", thinkAndCallNode)
    .addNode("tool_executor", toolNode)
    .addNode("continue_reasoning", continueReasoningNode)
    .addNode("extract_answer", extractAnswerNode)
    .addNode("reflect", reflectNode)

    // Edges
    .addEdge(START, "think_and_call")
    .addConditionalEdges("think_and_call", shouldUseTools, {
      tool_executor: "tool_executor",
      extract_answer: "extract_answer",
    })
    .addConditionalEdges("tool_executor", afterTools, {
      continue_reasoning: "continue_reasoning",
      extract_answer: "extract_answer",
    })
    .addConditionalEdges("continue_reasoning", shouldUseTools, {
      tool_executor: "tool_executor",
      extract_answer: "extract_answer",
    })
    .addEdge("extract_answer", "reflect")
    .addEdge("reflect", END);

  return graph.compile();
}

// =================================================================
// RUN AGENT  (runs the graph for one question)
// =================================================================
async function runAgent(question, task_id) {
  const app = buildGraph();

  const result = await app.invoke({
    question,
    task_id,
    messages: [],
    firstAnswer: "",
    finalAnswer: "",
    reflectDone: false,
  });

  return result.finalAnswer || "";
}

// =================================================================
// GAIA API helpers
// =================================================================
async function getQuestions() {
  const res = await axios.get(`${BASE_URL}/questions`);
  return res.data;
}

async function submitAnswers(answers) {
  const res = await axios.post(`${BASE_URL}/submit`, {
    username: "SonuChowdhury",                                                     
    agent_code: "hhttps://github.com/SonuuChowdhury/HUGGING-FACE-AI-AGENT-COURSE",
    answers,
  });
  console.log("\n🏆 SUBMISSION RESULT:", JSON.stringify(res.data, null, 2));
  return res.data;
}

// =================================================================
// MAIN
// =================================================================
async function main() {
  console.log("🚀 Starting LangGraph GAIA Agent\n");
  console.log("Graph flow:");
  console.log("  START → think_and_call → [tool_executor → continue_reasoning]* → extract_answer → reflect → END\n");

  const questions = await getQuestions();
  console.log(`📋 Got ${questions.length} questions\n`);

  const answers = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n[${i + 1}/${questions.length}] ${q.task_id}`);
    console.log(`  ❓ ${q.question.slice(0, 120)}${q.question.length > 120 ? "..." : ""}`);

    try {
      const answer = await runAgent(q.question, q.task_id);
      answers.push({ task_id: q.task_id, submitted_answer: answer });
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      answers.push({ task_id: q.task_id, submitted_answer: "" });
    }

    await sleep(500);
  }

  console.log("\n📤 Submitting...");
  await submitAnswers(answers);
}

main().catch(console.error);
