import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
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

interface CandidateProfile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  resume_score: number | null;
  prescreen_passed: boolean | null;
  interested: boolean | null;
  notice_period_days: number | null;
  phone_interview_score: number | null;
  notes: string | null;
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

function formatTarget(target?: string | null): string {
  if (!target) return "";
  if (target === "REJECT") return "Reject Candidate";
  if (target === "END") return "Finish Flow";
  return `Step ${target.replace(/^s/i, "")}`;
}

function formatAuditSummary(log: AuditLogEntry): string {
  const d = log.details || {};
  if (typeof d.summary === "string") return d.summary;
  if (typeof d.message === "string") return d.message;
  if (log.event_type === "CONDITION_EVALUATED") {
    return `Step ${d.step_id}: evaluated condition → ${d.result ? "Passed" : "Did not pass"}`;
  }
  if (log.event_type === "INSTRUCTION_PARSED") {
    return `Parsed instruction (${d.status})${d.clarification_question ? `: ${d.clarification_question}` : ""}`;
  }
  if (log.event_type === "WORKFLOW_CONFIRMED") {
    return `Recruiter confirmed workflow #${d.workflow_id} for execution`;
  }
  if (log.event_type === "RUN_STARTED") {
    return `Started '${d.workflow_name}' across ${d.total_candidates} candidates`;
  }
  if (log.event_type === "RUN_COMPLETED") {
    return `Completed run #${d.run_id} (${d.completed_candidates} candidates processed)`;
  }
  return JSON.stringify(d);
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      sender: "agent",
      text: "Tell me how you want to screen, message, interview, and route candidates. I will ask for clarification if needed and show a preview for your confirmation before anything runs.",
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
  const [candidates, setCandidates] = useState<CandidateProfile[]>([]);
  const [runMonitor, setRunMonitor] = useState<RunMonitorData | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"monitor" | "candidates" | "audit">("monitor");
  const [loading, setLoading] = useState(false);

  const loadCandidates = async () => {
    try {
      const res = await fetch(`${API_BASE}/candidates`);
      if (res.ok) {
        setCandidates(await res.json());
      }
    } catch {
      // Backend may not be running yet
    }
  };

  useEffect(() => {
    loadCandidates();
  }, []);

  const refreshAuditLogs = async (runId?: number) => {
    const url = runId ? `${API_BASE}/audit-logs?run_id=${runId}` : `${API_BASE}/audit-logs`;
    const res = await fetch(url);
    if (res.ok) {
      setAuditLogs(await res.json());
    }
  };

  const refreshRunMonitor = async (runId: number) => {
    const res = await fetch(`${API_BASE}/runs/${runId}`);
    if (res.ok) {
      setRunMonitor(await res.json());
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
            text: data.clarification_question,
            status: "clarification needed",
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
            text: `${data.raw_preview_summary || "Workflow ready."} Review the steps below and click Confirm & Execute to run.`,
            status: "ready for confirmation",
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
          text: "Backend offline at http://127.0.0.1:8000 — start uvicorn in your backend terminal.",
          status: "offline",
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
    <div className="min-h-screen bg-[#0b0c0e] text-[#e7e5e0] antialiased">
      <div className="max-w-5xl mx-auto px-5 py-8 space-y-6">
        {/* Top Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#23252a] pb-5">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-[#a8a29e]">
              <span className="h-2 w-2 rounded-full bg-emerald-400/90" />
              TransformNxt Prototype • Simulated Channels
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#f5f3ef]">
              Recruitment Automation Agent
            </h1>
          </div>

          <label className="inline-flex items-center gap-2.5 text-xs text-[#d6d3cd] bg-[#14161a] hover:bg-[#191c21] border border-[#272a30] px-3.5 py-2 rounded-xl cursor-pointer transition">
            <input
              type="checkbox"
              checked={simulateFailure}
              onChange={(e) => setSimulateFailure(e.target.checked)}
              className="rounded accent-amber-400"
            />
            Simulate Integration Failure
          </label>
        </header>

        {/* Quick Prompts */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-[#8c867e]">Quick Prompts</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {SAMPLE_PROMPTS.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSend(prompt)}
                className="text-left text-xs leading-relaxed bg-[#131519] hover:bg-[#191c22] border border-[#23262c] hover:border-[#363a42] text-[#cfc9c0] p-3.5 rounded-xl transition"
              >
                <span className="block font-medium text-[#e7e5e0] mb-1">
                  {idx === 0
                    ? "1. Full Screening & Interview Flow"
                    : idx === 1
                    ? "2. Notice Period + WhatsApp Flow"
                    : "3. Ambiguous Threshold Test"}
                </span>
                <span className="line-clamp-2 text-[#9c968e]">{prompt}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Chat + Composer Card */}
        <section className="bg-[#121418] border border-[#23262c] rounded-2xl overflow-hidden">
          <div className="p-4 sm:p-5 h-64 overflow-y-auto space-y-3.5">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed max-w-2xl ${
                  m.sender === "recruiter"
                    ? "bg-[#22252c] text-[#f5f3ef] ml-auto border border-[#323640]"
                    : "bg-[#181b20] text-[#dcd8d0] border border-[#252830]"
                }`}
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#9c968e] mb-1">
                  <span>{m.sender === "recruiter" ? "You" : "Agent"}</span>
                  {m.status && (
                    <span className="px-1.5 py-0.5 rounded bg-[#242830] text-[#c7c2b9]">
                      {m.status}
                    </span>
                  )}
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
            className="border-t border-[#22252b] bg-[#0f1114] p-3 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                clarificationQuestion
                  ? "Type your clarification answer..."
                  : "Describe a hiring workflow (e.g. resume score > 70, prescreen, WhatsApp, phone interview)..."
              }
              className="flex-1 bg-[#16191f] border border-[#262930] rounded-xl px-4 py-2.5 text-sm text-[#f5f3ef] placeholder:text-[#6e6962] focus:outline-none focus:border-[#4b505c]"
            />
            <button
              type="button"
              onClick={handleVoiceInput}
              className="bg-[#181b21] hover:bg-[#20242c] border border-[#2a2e37] text-[#d6d3cd] px-3.5 py-2.5 rounded-xl text-xs font-medium transition"
            >
              Voice
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-[#e7e5e0] hover:bg-white text-[#0b0c0e] font-medium px-4 py-2.5 rounded-xl text-xs transition disabled:opacity-40"
            >
              {loading ? "Working..." : "Send"}
            </button>
          </form>
        </section>

        {/* Workflow Preview & Confirmation */}
        {parsedWorkflow && (
          <section className="bg-[#121418] border border-[#282c34] rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#22252b] pb-4">
              <div className="space-y-1">
                <div className="text-[11px] uppercase tracking-wider text-amber-300/80">
                  Confirmation Required Before Execution
                </div>
                <h2 className="text-base font-semibold text-[#f5f3ef]">
                  {parsedWorkflow.workflow_name}
                </h2>
                {activeInstruction && (
                  <p className="text-xs text-[#9c968e] line-clamp-1">{activeInstruction}</p>
                )}
              </div>

              <button
                type="button"
                onClick={handleConfirmAndExecute}
                disabled={loading || !savedWorkflowId}
                className="bg-emerald-400/90 hover:bg-emerald-300 text-[#090b0d] font-semibold px-4 py-2.5 rounded-xl text-xs transition disabled:opacity-40"
              >
                {isConfirmed ? "Confirmed — Run Again" : "Confirm & Execute Workflow"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {parsedWorkflow.steps.map((step, index) => (
                <div
                  key={step.step_id}
                  className="bg-[#171a20] border border-[#252830] rounded-xl p-3.5 flex flex-col justify-between gap-2"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-[#b8b2a8]">Step {index + 1}</span>
                      <span className="uppercase tracking-wider text-[10px] px-2 py-0.5 rounded-md bg-[#22262e] text-[#cfc9c0]">
                        {step.step_type}
                      </span>
                    </div>
                    <div className="text-xs font-medium text-[#ece9e2] leading-snug">
                      {step.description}
                    </div>
                  </div>
                  <div className="text-[11px] text-[#8c867e] pt-1.5 border-t border-[#22262e]">
                    {step.on_true && <div>If Yes → {formatTarget(step.on_true)}</div>}
                    {step.on_false && <div>If No → {formatTarget(step.on_false)}</div>}
                    {step.next_step && <div>Next → {formatTarget(step.next_step)}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Live Monitor, Candidates & Audit Trail */}
        <section className="bg-[#121418] border border-[#23262c] rounded-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#22252b] pb-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("monitor")}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition ${
                  activeTab === "monitor"
                    ? "bg-[#e7e5e0] text-[#0b0c0e]"
                    : "bg-[#181b21] text-[#b8b2a8] hover:text-[#e7e5e0] border border-[#262930]"
                }`}
              >
                Live Monitor
              </button>
              <button
                type="button"
                onClick={async () => {
                  setActiveTab("candidates");
                  await loadCandidates();
                }}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition ${
                  activeTab === "candidates"
                    ? "bg-[#e7e5e0] text-[#0b0c0e]"
                    : "bg-[#181b21] text-[#b8b2a8] hover:text-[#e7e5e0] border border-[#262930]"
                }`}
              >
                Candidates ({candidates.length})
              </button>
              <button
                type="button"
                onClick={async () => {
                  setActiveTab("audit");
                  await refreshAuditLogs(runMonitor?.run_id);
                }}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition ${
                  activeTab === "audit"
                    ? "bg-[#e7e5e0] text-[#0b0c0e]"
                    : "bg-[#181b21] text-[#b8b2a8] hover:text-[#e7e5e0] border border-[#262930]"
                }`}
              >
                Audit Trail ({auditLogs.length})
              </button>
            </div>

            {runMonitor && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[#a8a29e] mr-1">
                  Run #{runMonitor.run_id} ·{" "}
                  <strong className="text-[#f5f3ef]">{runMonitor.status}</strong> (
                  {runMonitor.completed_candidates}/{runMonitor.total_candidates})
                </span>
                <button
                  type="button"
                  onClick={() => handleControlRun("pause")}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-[#191c22] hover:bg-[#22262e] border border-[#2c303a] text-[#dcd8d0]"
                >
                  Pause
                </button>
                <button
                  type="button"
                  onClick={() => handleControlRun("resume")}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-[#191c22] hover:bg-[#22262e] border border-[#2c303a] text-[#dcd8d0]"
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={() => handleControlRun("cancel")}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-rose-950/60 hover:bg-rose-900/70 border border-rose-800/70 text-rose-200"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {activeTab === "monitor" &&
            (runMonitor ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#22252b] text-[#8c867e]">
                      <th className="py-2.5 pr-4 font-medium">Candidate</th>
                      <th className="py-2.5 pr-4 font-medium">Step</th>
                      <th className="py-2.5 pr-4 font-medium">Status</th>
                      <th className="py-2.5 pr-4 font-medium">Outcome</th>
                      <th className="py-2.5 pr-4 font-medium">Next Action</th>
                      <th className="py-2.5 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1b1e24]">
                    {runMonitor.candidates.map((row) => (
                      <tr key={row.candidate_id} className="hover:bg-[#16191f]/60">
                        <td className="py-3 pr-4 font-medium text-[#f5f3ef]">{row.name}</td>
                        <td className="py-3 pr-4 font-mono text-[#b8b2a8]">{row.current_step || "-"}</td>
                        <td className="py-3 pr-4">
                          <span className="px-2 py-0.5 rounded-md bg-[#20242c] text-[#dcd8d0] text-[11px]">
                            {row.status}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-[#cfc9c0]">{row.outcome || "-"}</td>
                        <td className="py-3 pr-4 text-[#9c968e]">{row.next_action || "-"}</td>
                        <td className="py-3 text-rose-300">{row.error_message || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[#8c867e] py-2">
                No workflow run yet. Parse a workflow above and click{" "}
                <span className="text-[#dcd8d0]">Confirm &amp; Execute Workflow</span>.
              </p>
            ))}

          {activeTab === "candidates" && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#22252b] text-[#8c867e]">
                    <th className="py-2.5 pr-4 font-medium">Name</th>
                    <th className="py-2.5 pr-4 font-medium">Role</th>
                    <th className="py-2.5 pr-4 font-medium">Resume Score</th>
                    <th className="py-2.5 pr-4 font-medium">Prescreen</th>
                    <th className="py-2.5 pr-4 font-medium">Interested</th>
                    <th className="py-2.5 pr-4 font-medium">Notice (Days)</th>
                    <th className="py-2.5 font-medium">Interview Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1b1e24]">
                  {candidates.map((c) => (
                    <tr key={c.id} className="hover:bg-[#16191f]/60">
                      <td className="py-3 pr-4 font-medium text-[#f5f3ef]">{c.name}</td>
                      <td className="py-3 pr-4 text-[#cfc9c0]">{c.role}</td>
                      <td className="py-3 pr-4 text-[#e7e5e0]">{c.resume_score ?? "Missing"}</td>
                      <td className="py-3 pr-4 text-[#b8b2a8]">
                        {c.prescreen_passed === null ? "Unknown" : c.prescreen_passed ? "Passed" : "Failed"}
                      </td>
                      <td className="py-3 pr-4 text-[#b8b2a8]">
                        {c.interested === null ? "Unknown" : c.interested ? "Yes" : "No"}
                      </td>
                      <td className="py-3 pr-4 text-[#b8b2a8]">{c.notice_period_days ?? "Unknown"}</td>
                      <td className="py-3 text-[#e7e5e0]">{c.phone_interview_score ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "audit" && (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="bg-[#171a20] border border-[#24272f] rounded-xl p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-[#9c968e]">
                    <span className="font-medium text-[#e7e5e0]">{log.event_type}</span>
                    <span className="text-[11px]">{new Date(log.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-[#cfc9c0]">{formatAuditSummary(log)}</div>
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