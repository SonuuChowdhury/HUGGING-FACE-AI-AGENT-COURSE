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

// ================= DETECT TYPE =================
function detectType(q) {
  q = q.toLowerCase();

  if (q.includes("total") || q.includes("sum")) return "sum";
  if (q.includes("average")) return "avg";
  if (q.includes("how many")) return "count";
  if (q.includes("list") || q.includes("ingredients")) return "list";
  if (q.includes("code") || q.includes("id")) return "code";
  if (q.includes("who") || q.includes("name")) return "name";
  if (q.includes("city") || q.includes("country")) return "place";

  return "unknown";
}

// ================= PARSERS =================
const nums = t => (t.match(/-?\d+(\.\d+)?/g) || []).map(Number);
const names = t => t.match(/[A-Z][a-z]+/g) || [];
const codes = t => t.match(/[A-Z0-9]{6,}/g) || [];

// ================= SOLVER =================
function solveDeterministic(question, file) {
  if (!file) return null;

  const type = detectType(question);

  if (type === "sum") {
    const n = nums(file);
    if (n.length) return String(Math.round(n.reduce((a, b) => a + b, 0)));
  }

  if (type === "avg") {
    const n = nums(file);
    if (n.length) return String(Math.round(n.reduce((a, b) => a + b, 0) / n.length));
  }

  if (type === "count") {
    return String(file.split(/\n|,/).filter(x => x.trim()).length);
  }

  if (type === "list") {
    return file
      .split(/\n|,/)
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",");
  }

  if (type === "code") {
    const c = codes(file);
    if (c.length) return c[0];
  }

  if (type === "name") {
    const n = names(file);
    if (n.length) return n[0].toLowerCase();
  }

  if (type === "place") {
    const p = names(file);
    if (p.length) return p[0].toLowerCase();
  }

  return null;
}

// ================= NORMALIZATION (CRITICAL) =================
function normalize(ans) {
  if (!ans) return "N/A";

  ans = ans.trim().toLowerCase();

  // convert words → numbers
  const wordToNum = {
    one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8",
    nine: "9", ten: "10"
  };

  if (wordToNum[ans]) return wordToNum[ans];

  // remove bad answers
  const bad = ["indeed", "unknown", "none", "unable", "not provided"];
  if (bad.includes(ans)) return "N/A";

  // normalize lists
  if (ans.includes(",")) {
    return ans
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",");
  }

  return ans;
}

// ================= LLM =================
async function askLLM(question, file) {
  const res = await safeGenerate([
    {
      role: "user",
      parts: [{
        text: `
Answer in ONE word or short phrase only.

No explanation.
No extra text.

${file ? `FILE:\n${file.slice(0, 2000)}` : ""}

Question: ${question}
`
      }]
    }
  ]);

  return res.response.text().trim();
}

// ================= AGENT =================
async function runAgent(question, task_id) {
  const file = await getFile(task_id);

  // 1. deterministic
  const det = solveDeterministic(question, file);
  if (det) return normalize(det);

  // 2. fallback LLM
  const llm = await askLLM(question, file);
  return normalize(llm);
}

// ================= API =================
async function getQuestions() {
  const res = await axios.get(`${BASE_URL}/questions`);
  return res.data;
}

async function submitAnswers(answers) {
  const payload = {
    username: "SonuChowdhury",
    agent_code: "https://github.com/your-repo",

    answers: answers.map(a => ({
      task_id: a.task_id,
      submitted_answer: normalize(a.answer)
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