# 🤖 LangGraph GAIA Agent

> Built for the [Hugging Face AI Agents Course](https://huggingface.co/learn/agents-course) — Unit 4 Final Assignment

A multi-step reasoning agent powered by **Google Gemini 2.5 Flash** and **LangGraph**, designed to tackle the [GAIA benchmark](https://huggingface.co/spaces/gaia-benchmark/leaderboard) — a challenging set of real-world questions that require web search, file analysis, and multi-step reasoning.

---

## 🧠 What Is This Agent?

This agent takes a GAIA benchmark question, reasons through it step-by-step using tools, extracts an answer, then **reflects and self-corrects** before submitting. It's designed to output clean, precisely formatted answers — exactly what GAIA expects.

The agent follows a structured graph-based flow built with **LangGraph**, where each node handles a specific part of the reasoning pipeline.

---

## 🔁 How It Works — The Graph Flow

```
START
  └──▶ think_and_call        (LLM reasons + optionally calls tools)
          ├── [tool called] ──▶ tool_executor
          │                         └──▶ continue_reasoning  ──┐
          │                               (loops up to 6x)  ◀──┘
          └── [no tool]
                └──▶ extract_answer     (pulls final answer from messages)
                          └──▶ reflect  (second LLM pass to verify/correct)
                                    └──▶ END
```

### Node Breakdown

| Node | What It Does |
|------|-------------|
| `think_and_call` | The main reasoning node. Sends the question to Gemini with tools bound. The LLM decides whether to call a tool or answer directly. |
| `tool_executor` | Executes any tool calls the LLM made (web search, file fetch, calculator). |
| `continue_reasoning` | After tools run, feeds results back to the LLM so it can keep reasoning or call more tools. |
| `extract_answer` | Walks the message history in reverse to find the last AI text response and extracts a clean answer. |
| `reflect` | A second independent LLM call that reviews the first answer, checks for common GAIA traps, and optionally re-searches to verify. |

---

## 🛠️ Tools Available

### 🔍 `web_search`
Searches the web for factual information. Uses **Tavily** (if `TAVILY_API_KEY` is set) with a fallback to the **DuckDuckGo** instant answer API. Called automatically when the LLM needs current data, specific names, dates, or anything uncertain.

### 📎 `fetch_file`
Downloads the file attached to a GAIA task by `task_id`. Handles multiple file types:
- **Text / CSV / JSON / HTML** → returns raw content (up to 6000 chars)
- **Excel / PDF** → returns base64-encoded content
- **Images** → returns a special `__IMAGE__::` marker with base64 data

### 🧮 `calculator`
Evaluates safe JavaScript math expressions. Useful for arithmetic, percentages, and unit conversions. Only allows numeric characters and basic operators — no arbitrary code execution.

---

## 🔄 Key Design Decisions

### Multi-key Rotation
The agent accepts a comma-separated list of Gemini API keys (`GEMINI_API_KEYS`) and rotates through them. This helps avoid hitting rate limits (429s) on long benchmark runs. Failed requests automatically retry with exponential backoff.

### Two-Pass Answering (Think → Reflect)
Most agents stop after the first answer. This agent adds a **reflection pass** — a second LLM call that reviews the first answer and checks for common failure modes like:
- Wrong item (e.g., "last" vs "first")
- Wrong number format (digits vs words)
- Wrong capitalisation
- Missing table column lookup

### Tool Loop Capping
The tool-use loop is capped at **6 total tool calls** per question. This prevents infinite loops on ambiguous questions while still allowing multi-step research chains.

### Answer Normalisation
Raw LLM output is cleaned before submission:
- Strips `<thinking>...</thinking>` blocks (Gemini's chain-of-thought)
- Removes surrounding quotes
- Strips trailing punctuation
- Collapses whitespace
- Rejects non-answers ("I don't know", "unable to", etc.)

---

## 📁 Project Structure

```
.
├── agent.js          # Main agent code (single file)
├── .env              # API keys (not committed)
└── README.md
```

---

## ⚙️ Setup & Usage

### 1. Install Dependencies

```bash
npm install axios dotenv @langchain/google-genai @langchain/core @langchain/langgraph zod
```

### 2. Configure Environment

Create a `.env` file:

```env
# One or more Gemini API keys, comma-separated (for rotation)
GEMINI_API_KEYS=your_key_1,your_key_2

# Optional: Tavily for better web search (https://tavily.com)
TAVILY_API_KEY=your_tavily_key
```

### 3. Run

```bash
node agent.js
```

The agent will:
1. Fetch all questions from the GAIA scoring endpoint
2. Run each question through the graph
3. Submit all answers and print the score

---

## 📊 Benchmark Target

This agent targets the **GAIA Level 1** tasks from the Hugging Face Agents Course Unit 4 leaderboard. GAIA questions require real-world reasoning across web search, file reading, arithmetic, and multi-hop logic — they can't be answered from model weights alone.

---

## 🏗️ Built With

| Library | Role |
|---------|------|
| [LangGraph](https://github.com/langchain-ai/langgraphjs) | Agent graph orchestration |
| [LangChain (JS)](https://github.com/langchain-ai/langchainjs) | LLM + tool abstractions |
| [Google Gemini 2.5 Flash](https://deepmind.google/technologies/gemini/) | Core reasoning model |
| [Tavily](https://tavily.com) | Web search (primary) |
| [DuckDuckGo API](https://duckduckgo.com) | Web search (fallback) |
| [Zod](https://zod.dev) | Tool schema validation |
| [Axios](https://axios-http.com) | HTTP requests |

---

## 👤 Author

**Sonu Chowdhury**
GitHub: [@SonuuChowdhury](https://github.com/SonuuChowdhury/)

---
