import axios from "axios";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// ================= CONFIG =================
const BASE_URL = "https://agents-course-unit4-scoring.hf.space";

const keys = (process.env.GEMINI_API_KEYS || "").split(",");
let keyIndex = 0;

function getNextKey() {
  const key = keys[keyIndex];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

function getModel() {
  const genAI = new GoogleGenerativeAI(getNextKey());
  return genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
}

// ================= UTILS =================
const sleep = ms => new Promise(res => setTimeout(res, ms));

// ================= SAFE GENERATE =================
async function safeGenerate(messages, retries = 0) {
  try {
    const model = getModel();

    return await model.generateContent({
      contents: messages
    });

  } catch (err) {
    if (err.status === 429 && retries < keys.length) {
      console.log("⚠️ Rate limited → switching key...");
      await sleep(1000);
      return safeGenerate(messages, retries + 1);
    }

    if (retries >= keys.length) {
      console.log("⏳ All keys busy → waiting 10s...");
      await sleep(10000);
      return safeGenerate(messages, 0);
    }

    throw err;
  }
}

// ================= TOOLS =================
async function searchTool(query) {
  try {
    const res = await axios.get(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`
    );

    return (
      res.data.Abstract ||
      res.data.RelatedTopics?.map(r => r.Text).slice(0, 3).join("\n") ||
      "No result"
    );
  } catch {
    return "Search failed";
  }
}

async function getFile(task_id) {
  try {
    const res = await axios.get(`${BASE_URL}/files/${task_id}`, {
      responseType: "arraybuffer"
    });

    return res.data.toString("utf-8").slice(0, 2000);
  } catch {
    return null;
  }
}

// ================= AGENT =================
async function runAgent(question, task_id) {
  let context = "";
  const fileContent = await getFile(task_id);

  if (fileContent) {
    context += `FILE CONTENT:\n${fileContent}\n\n`;
  }

  let messages = [
    {
      role: "user",
      parts: [{
        text: `
You are a precise AI agent.

RULES:
- Answer ONLY what is asked
- Use file content if available
- Use search if needed
- No explanations
- No "I cannot access"
- Never leave empty

Return ONLY final answer.

${context}

Question: ${question}
`
      }]
    }
  ];

  let finalAnswer = "";

  for (let step = 0; step < 3; step++) {
    const result = await safeGenerate(messages);
    const output = result.response.text().trim();

    messages.push({
      role: "model",
      parts: [{ text: output }]
    });

    // If model tries search
    if (output.toLowerCase().includes("search:")) {
      const query = output.split("search:")[1]?.trim();
      if (query) {
        const obs = await searchTool(query);

        messages.push({
          role: "user",
          parts: [{ text: `Search result:\n${obs}` }]
        });

        continue;
      }
    }

    finalAnswer = output;
    break;
  }

  return cleanAnswer(finalAnswer);
}

// ================= CLEAN =================
function cleanAnswer(ans) {
  if (!ans || ans.trim() === "") return "N/A";

  return ans
    .replace(/final answer:/gi, "")
    .replace(/\n/g, " ")
    .trim();
}

// ================= API =================
async function getQuestions() {
  const res = await axios.get(`${BASE_URL}/questions`);
  return res.data;
}

async function submitAnswers(answers) {
  const payload = {
    username: "SonuChowdhury", 
    agent_code: "https://github.com/SonuuChowdhury/HUGGING-FACE-AI-AGENT-COURSE",

    answers: answers.map(a => ({
      task_id: a.task_id,
      submitted_answer: a.answer || "N/A"
    }))
  };

  const res = await axios.post(`${BASE_URL}/submit`, payload);

  console.log("🔥 FINAL SCORE:", res.data);
}

// ================= MAIN =================
async function main() {
  const questions = await getQuestions();
  const answers = [];

  for (const q of questions) {
    console.log("Solving:", q.task_id);

    const answer = await runAgent(q.question, q.task_id);

    answers.push({
      task_id: q.task_id,
      answer
    });

    console.log("Answer:", answer);
    console.log("--------------");
  }

  await submitAnswers(answers);
}

main();