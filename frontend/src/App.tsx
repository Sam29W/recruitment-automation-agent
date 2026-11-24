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

interface WorkflowStepPreview {
  step_id: string;
  step_type: string;
  description: string;
  on_true?: string | null;
  on_false?: string | null;
  next_step?: string | null;
}

interface ParsedWorkflowData {
  workflow_name: string;
  entry_step_id: string;
  requires_confirmation: boolean;
  steps: WorkflowStepPreview[];
}

interface CandidateMonitorRow {
  candidate_id: number;
  name: string;
  current_step: string | null;
  status: string;
  outcome: string | null;
  next_action: string | null;
  error_message: string | null;
}

interface RunMonitorData {
  run_id: number;
  workflow_id: number;
  status: string;
  total_candidates: number;
  completed_candidates: number;
  candidates: CandidateMonitorRow[];
}

interface AuditLogEntry {
  id: number;
  run_id: number | null;
  workflow_id: number | null;
  candidate_id: number | null;
  event_type: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      sender: "agent",
      text: "Describe your hiring automation workflow in plain English. Preview steps, confirm explicitly before actions run, and monitor progress live.",
    },
  ]);
  const [input, setInput] = useState("");
  const [activeInstruction, setActiveInstruction] = useState<string>("");
  const [pendingInstruction, setPendingInstruction] = useState<string | null>(null);
  const [clarificationQuestion, setClarificationQuestion] = useState<string | null>(null);
  const [parsedWorkflow, setParsedWorkflow] = useState<ParsedWorkflowData | null>(null);
  const [savedWorkflowId, setSavedWorkflowId] = useState<number | null>(null);
  const [isConfirmed, setIsConfirmed] = useState<boolean>(false);
  const [simulateFailure, setSimulateFailure] = useState<boolean>(false);
  const [runMonitor, setRunMonitor] = useState<RunMonitorData | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"monitor" | "audit">("monitor");
  const [loading, setLoading] = useState(false);

  const refreshAuditLogs = async (runId?: number) => {
    const url = runId ? `${API_BASE}/audit-logs?run_id=${runId}` : `${API_BASE}/audit-logs`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      setAuditLogs(data);
    }
  };

  const refreshRunMonitor = async (runId: number) => {
    const res = await fetch(`${API_BASE}/runs/${runId}`);
    if (res.ok) {
      const data = await res.json();
      setRunMonitor(data);
    }
  };

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || loading) return;

    const nextId = Date.now();
    setMessages((prev) => [...prev, { id: nextId, sender: "recruiter", text }]);
    setInput("");
    setLoading(true);

    try {
      const baseInstruction = pendingInstruction && clarificationQuestion ? pendingInstruction : text;
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
        setPendingInstruction(baseInstruction);
        setClarificationQuestion(data.clarification_question);
        setParsedWorkflow(null);
        setSavedWorkflowId(null);
        setIsConfirmed(false);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId + 1,
            sender: "agent",
            text: `Clarification needed: ${data.clarification_question}`,
            status: "clarification_needed",
          },
        ]);
      } else if (data.status === "workflow_ready" && data.workflow) {
        setPendingInstruction(null);
        setClarificationQuestion(null);
        setActiveInstruction(baseInstruction);
        setParsedWorkflow(data.workflow);
        setIsConfirmed(false);

        const saveRes = await fetch(`${API_BASE}/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            raw_instruction: baseInstruction,
            workflow: data.workflow,
          }),
        });
        const saved = await saveRes.json();
        setSavedWorkflowId(saved.id);

        setMessages((prev) => [
          ...prev,
          {
            id: nextId + 1,
            sender: "agent",
            text: `${data.raw_preview_summary || "Workflow structured."} Review the steps below and confirm before execution.`,
            status: "workflow_ready",
          },
        ]);
        await refreshAuditLogs();
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
          text: "Could not reach backend API at http://127.0.0.1:8000. Start FastAPI first.",
          status: "error",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmAndExecute = async () => {
    if (!savedWorkflowId || loading) return;
    setLoading(true);
    try {
      const confRes = await fetch(`${API_BASE}/workflows/${savedWorkflowId}/confirm`, {
        method: "POST",
      });
      if (!confRes.ok) return;
      setIsConfirmed(true);

      const execRes = await fetch(`${API_BASE}/workflows/${savedWorkflowId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulate_failure: simulateFailure }),
      });
      if (execRes.ok) {
        const execData = await execRes.json();
        await refreshRunMonitor(execData.run_id);
        await refreshAuditLogs(execData.run_id);
        setActiveTab("monitor");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleControlRun = async (action: "pause" | "resume" | "cancel") => {
    if (!runMonitor || loading) return;
    setLoading(true);
    try {
      await fetch(`${API_BASE}/runs/${runMonitor.run_id}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await refreshRunMonitor(runMonitor.run_id);
      await refreshAuditLogs(runMonitor.run_id);
    } finally {
      setLoading(false);
    }
  };

  const handleVoiceInput = () => {
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRec) {
      alert("Voice input is not supported in this browser; please type your instruction.");
      return;
    }
    const recognition = new SpeechRec();
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript || "";
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.start();
  };

  return (
    <div className="min-h-screen bg-[#0c0d10] text-stone-100 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="border-b border-stone-800 pb-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-stone-100">
              Recruitment Automation Agent
            </h1>
            <p className="text-sm text-stone-400 mt-1">
              Natural-language instruction → structured workflow preview → explicit confirmation → live monitor & audit trail.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-stone-300 bg-[#14161b] border border-stone-800 px-3 py-2 rounded-lg">
            <input
              type="checkbox"
              checked={simulateFailure}
              onChange={(e) => setSimulateFailure(e.target.checked)}
            />
            Simulate Integration Failure
          </label>
        </header>

        <div className="flex flex-wrap gap-2">
          {SAMPLE_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(prompt)}
              className="text-xs bg-stone-900 hover:bg-stone-800 border border-stone-700 text-stone-300 px-3 py-1.5 rounded-lg text-left transition"
            >
              Sample {idx + 1}: {prompt.slice(0, 62)}...
            </button>
          ))}
        </div>

        <div className="bg-[#14161b] border border-stone-800 rounded-xl p-4 h-64 overflow-y-auto space-y-3">
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
            {loading ? "Working..." : "Send"}
          </button>
        </form>

        {parsedWorkflow && (
          <section className="bg-[#14161b] border border-stone-800 rounded-xl p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-stone-400">
                  Workflow Preview & Explicit Confirmation Gate
                </div>
                <h2 className="text-base font-medium text-stone-100 mt-0.5">
                  {parsedWorkflow.workflow_name}
                </h2>
                {activeInstruction && (
                  <p className="text-xs text-stone-400 mt-0.5">Prompt: {activeInstruction}</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleConfirmAndExecute}
                disabled={loading || !savedWorkflowId}
                className="bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-medium px-4 py-2 rounded-lg text-sm disabled:opacity-50"
              >
                {isConfirmed ? "Confirmed — Run Again" : "Confirm & Execute Workflow"}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {parsedWorkflow.steps.map((step) => (
                <div
                  key={step.step_id}
                  className="bg-[#1c1f26] border border-stone-800 rounded-lg p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between text-stone-400">
                    <span className="font-mono text-stone-200">{step.step_id}</span>
                    <span className="uppercase">{step.step_type}</span>
                  </div>
                  <div className="text-stone-200 font-medium">{step.description}</div>
                  <div className="text-stone-400 font-mono text-[11px]">
                    {step.on_true ? `on_true: ${step.on_true} ` : ""}
                    {step.on_false ? `on_false: ${step.on_false} ` : ""}
                    {step.next_step ? `next: ${step.next_step}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="bg-[#14161b] border border-stone-800 rounded-xl p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-800 pb-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("monitor")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  activeTab === "monitor"
                    ? "bg-stone-100 text-stone-950"
                    : "bg-stone-900 text-stone-300 border border-stone-700"
                }`}
              >
                Live Monitor
              </button>
              <button
                type="button"
                onClick={async () => {
                  setActiveTab("audit");
                  await refreshAuditLogs(runMonitor?.run_id);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  activeTab === "audit"
                    ? "bg-stone-100 text-stone-950"
                    : "bg-stone-900 text-stone-300 border border-stone-700"
                }`}
              >
                Audit Trail ({auditLogs.length})
              </button>
            </div>

            {runMonitor && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">
                  Run #{runMonitor.run_id} • <strong className="text-stone-200">{runMonitor.status}</strong> (
                  {runMonitor.completed_candidates}/{runMonitor.total_candidates})
                </span>
                <button
                  type="button"
                  onClick={() => handleControlRun("pause")}
                  className="px-2.5 py-1 rounded text-xs bg-stone-800 hover:bg-stone-700 border border-stone-600"
                >
                  Pause
                </button>
                <button
                  type="button"
                  onClick={() => handleControlRun("resume")}
                  className="px-2.5 py-1 rounded text-xs bg-stone-800 hover:bg-stone-700 border border-stone-600"
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={() => handleControlRun("cancel")}
                  className="px-2.5 py-1 rounded text-xs bg-red-950 hover:bg-red-900 text-red-200 border border-red-800"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {activeTab === "monitor" ? (
            runMonitor ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-stone-800 text-stone-400">
                      <th className="py-2 pr-3">Candidate</th>
                      <th className="py-2 pr-3">Step</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Outcome</th>
                      <th className="py-2 pr-3">Next Action</th>
                      <th className="py-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runMonitor.candidates.map((row) => (
                      <tr key={row.candidate_id} className="border-b border-stone-900">
                        <td className="py-2.5 pr-3 font-medium text-stone-100">{row.name}</td>
                        <td className="py-2.5 pr-3 font-mono text-stone-300">{row.current_step || "-"}</td>
                        <td className="py-2.5 pr-3 text-stone-200">{row.status}</td>
                        <td className="py-2.5 pr-3 text-stone-300">{row.outcome || "-"}</td>
                        <td className="py-2.5 pr-3 text-stone-400">{row.next_action || "-"}</td>
                        <td className="py-2.5 text-red-300">{row.error_message || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-stone-400">
                No workflow run yet. Parse a workflow and click <strong>Confirm & Execute Workflow</strong>.
              </p>
            )
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="bg-[#1c1f26] border border-stone-800 rounded-lg p-2.5 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between text-stone-400">
                    <span className="font-mono text-stone-200">{log.event_type}</span>
                    <span>{log.created_at}</span>
                  </div>
                  <pre className="text-[11px] text-stone-300 overflow-x-auto">
                    {JSON.stringify(log.details)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default App;