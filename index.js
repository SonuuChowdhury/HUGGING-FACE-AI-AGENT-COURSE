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
    return await model.generateContent({ contents: messages });

  } catch (err) {
    if (err.status === 429 && retries < keys.length) {
      await sleep(1000);
      return safeGenerate(messages, retries + 1);
    }

    if (retries >= keys.length) {
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

    return res.data.toString("utf-8");
  } catch {
    return null;
  }
}

// ================= 🔥 SMART EXTRACTOR =================
function quickExtract(question, file) {
  if (!file) return null;

  const q = question.toLowerCase();

  // 🔢 sum / total
  if (q.includes("total") || q.includes("sum")) {
    const nums = file.match(/-?\d+(\.\d+)?/g);
    if (nums) {
      const sum = nums.reduce((a, b) => a + Number(b), 0);
      return String(sum);
    }
  }

  // 🔢 find numbers
  if (q.includes("list") || q.includes("numbers")) {
    const nums = file.match(/\d+/g);
    if (nums) return nums.slice(0, 6).join(",");
  }

  // 🔤 code / id
  if (q.includes("code") || q.includes("id")) {
    const code = file.match(/[A-Z0-9]{6,}/);
    if (code) return code[0];
  }

  // 👤 names
  if (q.includes("who") || q.includes("name")) {
    const names = file.match(/[A-Z][a-z]+/g);
    if (names) return names[0];
  }

  // 🌍 country / city
  if (q.includes("where") || q.includes("city") || q.includes("country")) {
    const places = file.match(/[A-Z][a-z]+/g);
    if (places) return places[0];
  }

  // 📦 CSV-like lists
  if (file.includes(",") && (q.includes("list") || q.includes("ingredients"))) {
    return file
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 10)
      .join(", ");
  }

  return null;
}

// ================= AGENT =================
async function runAgent(question, task_id) {
  const fileContent = await getFile(task_id);

  // 🔥 FIRST: deterministic extraction
  const extracted = quickExtract(question, fileContent);
  if (extracted) return extracted;

  // fallback → LLM
  let messages = [
    {
      role: "user",
      parts: [{
        text: `
Answer VERY briefly.

Rules:
- One word or short phrase
- No explanation
- No "I cannot"
- No guessing sentences

${fileContent ? `FILE:\n${fileContent.slice(0, 2000)}` : ""}

Question: ${question}
`
      }]
    }
  ];

  let finalAnswer = "";

  for (let step = 0; step < 5; step++) {
    const result = await safeGenerate(messages);
    const output = result.response.text().trim();

    messages.push({
      role: "model",
      parts: [{ text: output }]
    });

    if (output.toLowerCase().includes("search:")) {
      const query = output.split("search:")[1]?.trim();
      if (query) {
        const obs = await searchTool(query);

        messages.push({
          role: "user",
          parts: [{ text: `Search:\n${obs}` }]
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
  if (!ans) return "N/A";

  const bad = ["cannot", "unknown", "not provided", "no data"];

  if (bad.some(b => ans.toLowerCase().includes(b))) {
    return "N/A";
  }

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