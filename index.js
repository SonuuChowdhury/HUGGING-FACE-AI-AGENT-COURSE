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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= SAFE GENERATE =================
async function safeGenerate(messages, retries = 0) {
  try {
    const model = getModel();
    return await model.generateContent({ contents: messages });

  } catch (err) {
    if (err.status === 429 && retries < keys.length) {
      await sleep(800);
      return safeGenerate(messages, retries + 1);
    }

    if (retries >= keys.length) {
      await sleep(8000);
      return safeGenerate(messages, 0);
    }

    throw err;
  }
}

// ================= FILE =================
async function getFile(task_id) {
  try {
    const res = await axios.get(`${BASE_URL}/files/${task_id}`, {
      responseType: "arraybuffer"
    });

    return res.data.toString("utf-8");
  } catch {
    return "";
  }
}

// ================= 🧠 QUESTION TYPE =================
function detectType(q) {
  q = q.toLowerCase();

  if (q.includes("total") || q.includes("sum")) return "sum";
  if (q.includes("average") || q.includes("mean")) return "avg";
  if (q.includes("how many")) return "count";
  if (q.includes("list")) return "list";
  if (q.includes("code") || q.includes("id")) return "code";
  if (q.includes("who") || q.includes("name")) return "name";
  if (q.includes("where") || q.includes("city") || q.includes("country")) return "place";
  if (q.includes("which") || q.includes("choose")) return "mcq";

  return "unknown";
}

// ================= 🔥 PARSERS =================
function extractNumbers(text) {
  return (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
}

function extractWords(text) {
  return text.match(/[A-Za-z]+/g) || [];
}

function extractCodes(text) {
  return text.match(/[A-Z0-9]{6,}/g) || [];
}

function extractNames(text) {
  return text.match(/[A-Z][a-z]+/g) || [];
}

// ================= 🔥 SMART SOLVER =================
function solveDeterministic(question, file) {
  if (!file) return null;

  const type = detectType(question);

  // 🔢 SUM
  if (type === "sum") {
    const nums = extractNumbers(file);
    if (nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0);
      return String(Math.round(sum * 100) / 100);
    }
  }

  // 🔢 AVERAGE
  if (type === "avg") {
    const nums = extractNumbers(file);
    if (nums.length) {
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return String(Math.round(avg * 100) / 100);
    }
  }

  // 🔢 COUNT
  if (type === "count") {
    const items = file.split(/\n|,/).filter(x => x.trim());
    return String(items.length);
  }

  // 📦 LIST
  if (type === "list") {
    const items = file
      .split(/\n|,/)
      .map(x => x.trim())
      .filter(Boolean);

    return items.slice(0, 10).join(", ");
  }

  // 🔤 CODE
  if (type === "code") {
    const codes = extractCodes(file);
    if (codes.length) return codes[0];
  }

  // 👤 NAME
  if (type === "name") {
    const names = extractNames(file);
    if (names.length) return names[0];
  }

  // 🌍 PLACE
  if (type === "place") {
    const names = extractNames(file);
    if (names.length) return names[0];
  }

  return null;
}

// ================= 🤖 LLM FALLBACK =================
async function askLLM(question, file) {
  const messages = [
    {
      role: "user",
      parts: [{
        text: `
Answer in ONE word or short phrase only.

No explanation.
No "I cannot".
No sentences.

${file ? `FILE:\n${file.slice(0, 2000)}` : ""}

Question: ${question}
`
      }]
    }
  ];

  const res = await safeGenerate(messages);
  return res.response.text().trim();
}

// ================= CLEAN =================
function clean(ans) {
  if (!ans) return "N/A";

  const bad = ["cannot", "unknown", "not provided", "missing", "unavailable"];

  if (bad.some(b => ans.toLowerCase().includes(b))) {
    return "N/A";
  }

  return ans
    .replace(/\n/g, " ")
    .replace(/final answer:/gi, "")
    .trim();
}

// ================= AGENT =================
async function runAgent(question, task_id) {
  const file = await getFile(task_id);

  // 🔥 1. deterministic solve
  const det = solveDeterministic(question, file);
  if (det) return det;

  // 🔥 2. fallback LLM
  const llm = await askLLM(question, file);
  return clean(llm);
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