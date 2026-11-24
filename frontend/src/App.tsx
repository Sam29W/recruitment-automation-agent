import { useState } from "react";

const API_BASE = "http://127.0.0.1:8000";

const SAMPLE_PROMPTS = [
  "Select candidates whose AI Resume Score is above 70. Trigger AI prescreen phone calls. If a candidate does not pass the phone prescreen, send them a WhatsApp questionnaire to check their interest and ask basic HR questions. For candidates who are interested and have a notice period below 30 days, trigger an AI Phone Interview. If they score above 60 in the AI Phone Interview, send an email alert to both the recruiter and the Hiring Manager.",
  "Filter candidates with AI Resume Score above 75 and notice period under 30 days, send a WhatsApp questionnaire, and email the recruiter.",
  "Send an email alert if candidates have a high score",
];

interface ChatMessage {
  id: number;
  sender: "recruiter" | "agent";
  text: string;
  status?: string;
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      sender: "agent",
      text: "Describe your hiring automation workflow in plain English. I will parse conditions, actions, and recipients—or ask for clarification if a rule is ambiguous.",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingInstruction, setPendingInstruction] = useState<string | null>(null);
  const [clarificationQuestion, setClarificationQuestion] = useState<string | null>(null);
  const [parsedWorkflow, setParsedWorkflow] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || loading) return;

    const nextId = Date.now();
    setMessages((prev) => [...prev, { id: nextId, sender: "recruiter", text }]);
    setInput("");
    setLoading(true);

    try {
      const bodyPayload =
        pendingInstruction && clarificationQuestion
          ? {
              instruction: pendingInstruction,
              clarifications: { clarification_answer: text },
            }
          : { instruction: text };

      const res = await fetch(`${API_BASE}/workflows/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();

      if (data.status === "clarification_needed") {
        setPendingInstruction(pendingInstruction ?? text);
        setClarificationQuestion(data.clarification_question);
        setParsedWorkflow(null);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId + 1,
            sender: "agent",
            text: `Clarification needed: ${data.clarification_question}`,
            status: "clarification_needed",
          },
        ]);
      } else if (data.status === "workflow_ready") {
        setPendingInstruction(null);
        setClarificationQuestion(null);
        setParsedWorkflow(data.workflow);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId + 1,
            sender: "agent",
            text: data.raw_preview_summary || "Workflow structured and ready for review.",
            status: "workflow_ready",
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId + 1,
            sender: "agent",
            text: data.clarification_question || "Could not parse that instruction.",
            status: data.status,
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId + 1,
          sender: "agent",
          text: "Could not reach backend API at http://127.0.0.1:8000. Make sure FastAPI is running.",
          status: "error",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleVoiceInput = () => {
    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition })
        .webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Voice input is not supported in this browser; please type your instruction.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript || "";
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.start();
  };

  return (
    <div className="min-h-screen bg-[#0c0d10] text-stone-100 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="border-b border-stone-800 pb-4">
          <h1 className="text-xl font-semibold tracking-tight text-stone-100">
            Recruitment Automation Agent — Chat & Clarification
          </h1>
          <p className="text-sm text-stone-400 mt-1">
            Step 4.1: Natural-language instruction parser with ambiguity detection & optional voice input.
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          {SAMPLE_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(prompt)}
              className="text-xs bg-stone-900 hover:bg-stone-800 border border-stone-700 text-stone-300 px-3 py-1.5 rounded-lg text-left transition"
            >
              Sample {idx + 1}: {prompt.slice(0, 65)}...
            </button>
          ))}
        </div>

        <div className="bg-[#14161b] border border-stone-800 rounded-xl p-4 h-80 overflow-y-auto space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`p-3 rounded-lg text-sm max-w-2xl ${
                m.sender === "recruiter"
                  ? "bg-stone-800 text-stone-100 ml-auto"
                  : "bg-[#1c1f26] border border-stone-800 text-stone-200"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-1">
                {m.sender === "recruiter" ? "Recruiter" : "Agent"}
                {m.status ? ` • ${m.status}` : ""}
              </div>
              <div>{m.text}</div>
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              clarificationQuestion
                ? "Type your clarification answer..."
                : "Type a hiring workflow instruction..."
            }
            className="flex-1 bg-[#14161b] border border-stone-700 rounded-lg px-3.5 py-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:outline-none focus:border-stone-400"
          />
          <button
            type="button"
            onClick={handleVoiceInput}
            className="bg-stone-900 hover:bg-stone-800 border border-stone-700 text-stone-200 px-3.5 py-2.5 rounded-lg text-sm"
          >
            Voice
          </button>
          <button
            type="submit"
            disabled={loading}
            className="bg-stone-100 hover:bg-white text-stone-950 font-medium px-4 py-2.5 rounded-lg text-sm disabled:opacity-50"
          >
            {loading ? "Parsing..." : "Send"}
          </button>
        </form>

        {parsedWorkflow && (
          <div className="bg-[#14161b] border border-stone-800 rounded-xl p-4">
            <div className="text-xs uppercase tracking-wider text-stone-400 mb-2">
              Parsed Structured Workflow Preview (Draft)
            </div>
            <pre className="text-xs text-stone-300 overflow-x-auto">
              {JSON.stringify(parsedWorkflow, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;