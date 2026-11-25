import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

const SAMPLE_PROMPTS = [
  {
    tag: "Multi-Branch",
    title: "Full Screening & Interview Flow",
    prompt:
      "Select candidates whose AI Resume Score is above 70. Trigger AI prescreen phone calls. If a candidate does not pass the phone prescreen, send them a WhatsApp questionnaire to check their interest and ask basic HR questions. For candidates who are interested and have a notice period below 30 days, trigger an AI Phone Interview. If they score above 60 in the AI Phone Interview, send an email alert to both the recruiter and the Hiring Manager.",
  },
  {
    tag: "Fast-Track",
    title: "Notice Period + WhatsApp Flow",
    prompt:
      "Filter candidates with AI Resume Score above 75 and notice period under 30 days, send a WhatsApp questionnaire, and email the recruiter.",
  },
  {
    tag: "Guardrail",
    title: "Ambiguous Threshold Test",
    prompt: "Send an email alert if candidates have a high score",
  },
];

interface ChatMessage {
  id: number;
  sender: "recruiter" | "agent";
  text: string;
  status?: string;
  timestamp: string;
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

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTarget(target?: string | null): string {
  if (!target) return "";
  if (target === "REJECT") return "Reject";
  if (target === "END") return "Complete";
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

function stepBadgeStyle(type: string): string {
  const t = type.toLowerCase();
  if (t === "filter") return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  if (t === "action") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (t === "branch") return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  return "bg-zinc-800 text-zinc-300 border-zinc-700";
}

function statusPillStyle(status: string): string {
  const s = status.toUpperCase();
  if (s === "COMPLETED") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (s === "FAILED" || s === "ERROR") return "bg-rose-500/15 text-rose-300 border-rose-500/30";
  if (s === "SKIPPED" || s === "REJECTED") return "bg-zinc-800/90 text-zinc-400 border-zinc-700/80";
  if (s === "PAUSED") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

function countInitialMatches(
  workflow: ParsedWorkflowData | null,
  pool: CandidateProfile[]
): { matched: number; total: number; label: string } | null {
  if (!workflow || !pool.length) return null;
  const firstStep =
    workflow.steps.find((s) => s.step_id === workflow.entry_step_id) || workflow.steps[0];
  if (!firstStep || firstStep.step_type !== "filter") return null;

  const desc = firstStep.description.toLowerCase();
  const numMatch = desc.match(/(?:>|above|over|greater than|>=)\s*(\d+(?:\.\d+)?)/);
  if (!numMatch) return null;

  const threshold = parseFloat(numMatch[1]);
  const isInclusive = desc.includes(">=") || desc.includes("at least");

  const matched = pool.filter((c) => {
    if (c.resume_score === null || c.resume_score === undefined) return false;
    return isInclusive ? c.resume_score >= threshold : c.resume_score > threshold;
  }).length;

  return {
    matched,
    total: pool.length,
    label: `${matched} / ${pool.length} candidates match initial filter`,
  };
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      sender: "agent",
      text: "Describe your hiring workflow in plain English. I will validate criteria, ask clarifying questions if rules are ambiguous, and stage a preview for your approval before contacting any candidate.",
      timestamp: nowTime(),
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
  const [backendStatus, setBackendStatus] = useState<"checking" | "online" | "waking">("checking");
  const [loading, setLoading] = useState(false);

  const loadCandidates = async () => {
    try {
      const res = await fetch(`${API_BASE}/candidates`);
      if (res.ok) {
        setCandidates(await res.json());
        setBackendStatus("online");
      } else {
        setBackendStatus("waking");
      }
    } catch {
      setBackendStatus("waking");
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
    setMessages((prev) => [
      ...prev,
      { id: nextId, sender: "recruiter", text, timestamp: nowTime() },
    ]);
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
      setBackendStatus("online");
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
            timestamp: nowTime(),
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
            text: `${data.raw_preview_summary || "Workflow structured."} Inspect the pipeline on the right and click Confirm & Execute to launch.`,
            status: "staged",
            timestamp: nowTime(),
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
            timestamp: nowTime(),
          },
        ]);
      }
    } catch {
      setBackendStatus("waking");
      setMessages((prev) => [
        ...prev,
        {
          id: nextId + 1,
          sender: "agent",
          text: "Backend is waking up or unreachable. Wait 20–30 seconds for Render cold start and try sending again.",
          status: "reconnecting",
          timestamp: nowTime(),
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

  const initialMatchSummary = countInitialMatches(parsedWorkflow, candidates);
  const completedCount =
    runMonitor?.candidates.filter((c) => c.status.toUpperCase() === "COMPLETED").length ?? 0;
  const skippedCount =
    runMonitor?.candidates.filter((c) => c.status.toUpperCase() === "SKIPPED").length ?? 0;
  const failedCount =
    runMonitor?.candidates.filter((c) => ["FAILED", "ERROR"].includes(c.status.toUpperCase())).length ?? 0;

  return (
    <div className="min-h-screen bg-[#090a0c] text-[#eceae4] antialiased selection:bg-amber-400/20 selection:text-amber-200">
      <header className="sticky top-0 z-20 border-b border-[#1d2026] bg-[#090a0c]/90 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#262932] to-[#14161b] border border-[#2f333e] flex items-center justify-center text-xs font-bold tracking-wider text-amber-300 shadow-inner">
              TN
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-base font-semibold tracking-tight text-[#f7f5f0]">
                  TransformNxt Recruitment Agent
                </h1>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                    backendStatus === "online"
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                      : "bg-amber-500/10 text-amber-300 border-amber-500/25"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      backendStatus === "online" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
                    }`}
                  />
                  {backendStatus === "online" ? "Engine Online" : "Waking Engine..."}
                </span>
              </div>
              <p className="text-xs text-[#8f8980]">
                Natural-language workflow compiler · Human-in-the-loop gate · Deterministic audit engine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2.5 text-xs text-[#d6d2ca] bg-[#121419] hover:bg-[#171a21] border border-[#252932] px-3.5 py-2 rounded-xl cursor-pointer transition">
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(e) => setSimulateFailure(e.target.checked)}
                className="rounded accent-amber-400"
              />
              <span>Simulate Channel Failure</span>
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-5 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 space-y-5">
          <section className="bg-[#101216] border border-[#1f2229] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-widest text-[#8f8980]">
                Scenario Presets
              </span>
              <span className="text-[11px] text-[#6d6860]">Click to test</span>
            </div>

            <div className="space-y-2">
              {SAMPLE_PROMPTS.map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSend(item.prompt)}
                  className="w-full text-left group bg-[#15181e] hover:bg-[#1a1e26] border border-[#232730] hover:border-[#353b48] rounded-xl p-3 transition"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-medium text-[#f2efe9] group-hover:text-amber-200 transition">
                      {item.title}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-[#1f232c] text-[#a6a097] border border-[#2c313d]">
                      {item.tag}
                    </span>
                  </div>
                  <p className="text-xs text-[#8f8980] line-clamp-2 leading-relaxed">{item.prompt}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="bg-[#101216] border border-[#1f2229] rounded-2xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#1d2027] flex items-center justify-between bg-[#13151a]">
              <span className="text-xs font-medium text-[#dcd8d0]">Recruiter Copilot</span>
              {clarificationQuestion && (
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  Awaiting Clarification
                </span>
              )}
            </div>

            <div className="p-4 h-[360px] overflow-y-auto space-y-3.5">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.sender === "recruiter" ? "items-end" : "items-start"}`}
                >
                  <div
                    className={`rounded-2xl px-4 py-3 text-xs sm:text-[13px] leading-relaxed max-w-[90%] ${
                      m.sender === "recruiter"
                        ? "bg-[#232731] text-[#f7f5f0] border border-[#343947]"
                        : "bg-[#161920] text-[#dcd8d0] border border-[#242832]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider text-[#8f8980] mb-1.5">
                      <span>{m.sender === "recruiter" ? "Recruiter" : "Agent"}</span>
                      <div className="flex items-center gap-1.5">
                        {m.status && (
                          <span className="px-1.5 py-0.5 rounded bg-[#222630] text-[#c9c3b8]">
                            {m.status}
                          </span>
                        )}
                        <span>{m.timestamp}</span>
                      </div>
                    </div>
                    <div>{m.text}</div>
                  </div>
                </div>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="border-t border-[#1d2027] bg-[#0d0f12] p-3 space-y-2"
            >
              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  clarificationQuestion
                    ? "Type your clarification answer and press Enter..."
                    : "Describe hiring rules & actions (e.g. Resume score > 75, AI prescreen call, WhatsApp check, email recruiter)..."
                }
                className="w-full resize-none bg-[#15181e] border border-[#252933] rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-[#f7f5f0] placeholder:text-[#68635c] focus:outline-none focus:border-amber-400/50"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-[#6d6860]">Enter to send · Shift+Enter for new line</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleVoiceInput}
                    className="bg-[#171a21] hover:bg-[#1f232c] border border-[#292d38] text-[#d6d2ca] px-3 py-1.5 rounded-xl text-xs font-medium transition"
                  >
                    Voice
                  </button>
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="bg-[#eceae4] hover:bg-white text-[#090a0c] font-semibold px-4 py-1.5 rounded-xl text-xs transition disabled:opacity-40"
                  >
                    {loading ? "Parsing..." : "Build Workflow"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>

        <div className="lg:col-span-7 space-y-5">
          <section className="bg-[#101216] border border-[#1f2229] rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1d2027] pb-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-widest text-amber-300/90">
                    Workflow Blueprint
                  </span>
                  {parsedWorkflow && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#1b1e26] text-[#b8b2a8] border border-[#2a2e39]">
                      {parsedWorkflow.steps.length} steps
                    </span>
                  )}
                  {initialMatchSummary && (
                    <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300 border border-sky-500/25">
                      {initialMatchSummary.label}
                    </span>
                  )}
                </div>
                <h2 className="text-base font-semibold text-[#f7f5f0]">
                  {parsedWorkflow ? parsedWorkflow.workflow_name : "No Workflow Staged Yet"}
                </h2>
                {activeInstruction && (
                  <p className="text-xs text-[#8f8980] line-clamp-1">{activeInstruction}</p>
                )}
              </div>

              <button
                type="button"
                onClick={handleConfirmAndExecute}
                disabled={loading || !savedWorkflowId}
                className="bg-emerald-400 hover:bg-emerald-300 text-[#080a0c] font-semibold px-4 py-2.5 rounded-xl text-xs shadow-sm transition disabled:opacity-35 disabled:cursor-not-allowed"
              >
                {isConfirmed ? "Confirmed · Re-Run Workflow" : "Confirm & Execute Workflow"}
              </button>
            </div>

            {parsedWorkflow ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {parsedWorkflow.steps.map((step, index) => (
                  <div
                    key={step.step_id}
                    className="bg-[#15181e] border border-[#232731] rounded-xl p-3.5 flex flex-col justify-between gap-2.5"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-[#a6a097]">
                          STAGE {index + 1}
                        </span>
                        <span
                          className={`uppercase tracking-wider text-[10px] font-medium px-2 py-0.5 rounded-md border ${stepBadgeStyle(
                            step.step_type
                          )}`}
                        >
                          {step.step_type}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-[#f2efe9] leading-relaxed">
                        {step.description}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#20242d] text-[11px]">
                      {step.on_true && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                          Yes → {formatTarget(step.on_true)}
                        </span>
                      )}
                      {step.on_false && (
                        <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20">
                          No → {formatTarget(step.on_false)}
                        </span>
                      )}
                      {step.next_step && (
                        <span className="px-2 py-0.5 rounded bg-[#1e222b] text-[#b8b2a8] border border-[#2a2f3b]">
                          Next → {formatTarget(step.next_step)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-[#242832] rounded-xl p-6 text-center space-y-1.5 bg-[#12141a]/60">
                <p className="text-xs font-medium text-[#cfc9c0]">
                  Select a preset on the left or write your own hiring rule
                </p>
                <p className="text-xs text-[#7d776f]">
                  Every workflow stages here for human review before any simulated call, WhatsApp, or email triggers.
                </p>
              </div>
            )}
          </section>

          <section className="bg-[#101216] border border-[#1f2229] rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1d2027] pb-3.5">
              <div className="flex flex-wrap items-center gap-1.5 bg-[#15181e] p-1 rounded-xl border border-[#222630]">
                <button
                  type="button"
                  onClick={() => setActiveTab("monitor")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    activeTab === "monitor"
                      ? "bg-[#eceae4] text-[#090a0c] shadow-sm"
                      : "text-[#9c968e] hover:text-[#eceae4]"
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
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    activeTab === "candidates"
                      ? "bg-[#eceae4] text-[#090a0c] shadow-sm"
                      : "text-[#9c968e] hover:text-[#eceae4]"
                  }`}
                >
                  Candidate Pool ({candidates.length})
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setActiveTab("audit");
                    await refreshAuditLogs(runMonitor?.run_id);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    activeTab === "audit"
                      ? "bg-[#eceae4] text-[#090a0c] shadow-sm"
                      : "text-[#9c968e] hover:text-[#eceae4]"
                  }`}
                >
                  Audit Trail ({auditLogs.length})
                </button>
              </div>

              {runMonitor && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-[#9c968e] mr-1">
                    Run #{runMonitor.run_id} ·{" "}
                    <strong className="text-[#f7f5f0]">{runMonitor.status}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleControlRun("pause")}
                    className="px-2.5 py-1.5 rounded-lg text-xs bg-[#171a21] hover:bg-[#20242e] border border-[#2a2f3b] text-[#dcd8d0] transition"
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    onClick={() => handleControlRun("resume")}
                    className="px-2.5 py-1.5 rounded-lg text-xs bg-[#171a21] hover:bg-[#20242e] border border-[#2a2f3b] text-[#dcd8d0] transition"
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    onClick={() => handleControlRun("cancel")}
                    className="px-2.5 py-1.5 rounded-lg text-xs bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 transition"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {runMonitor && activeTab === "monitor" && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-[#15181e] border border-[#222630] rounded-xl px-3.5 py-2.5">
                  <div className="text-[11px] text-[#8f8980]">Total Pool</div>
                  <div className="text-lg font-semibold text-[#f7f5f0]">
                    {runMonitor.total_candidates}
                  </div>
                </div>
                <div className="bg-[#15181e] border border-[#222630] rounded-xl px-3.5 py-2.5">
                  <div className="text-[11px] text-emerald-300/80">Completed Flow</div>
                  <div className="text-lg font-semibold text-emerald-300">{completedCount}</div>
                </div>
                <div className="bg-[#15181e] border border-[#222630] rounded-xl px-3.5 py-2.5">
                  <div className="text-[11px] text-[#8f8980]">Filtered Out</div>
                  <div className="text-lg font-semibold text-[#cfc9c0]">{skippedCount}</div>
                </div>
                <div className="bg-[#15181e] border border-[#222630] rounded-xl px-3.5 py-2.5">
                  <div className="text-[11px] text-rose-300/80">Channel Errors</div>
                  <div className="text-lg font-semibold text-rose-300">{failedCount}</div>
                </div>
              </div>
            )}

            {activeTab === "monitor" &&
              (runMonitor ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-[#1f2229] text-[#8f8980]">
                        <th className="py-2.5 pr-4 font-medium">Candidate</th>
                        <th className="py-2.5 pr-4 font-medium">Stage</th>
                        <th className="py-2.5 pr-4 font-medium">Status</th>
                        <th className="py-2.5 pr-4 font-medium">Outcome</th>
                        <th className="py-2.5 pr-4 font-medium">Next Action</th>
                        <th className="py-2.5 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#191c22]">
                      {runMonitor.candidates.map((row) => (
                        <tr key={row.candidate_id} className="hover:bg-[#15181e]/80 transition">
                          <td className="py-3 pr-4 font-medium text-[#f7f5f0] whitespace-nowrap">
                            {row.name}
                          </td>
                          <td className="py-3 pr-4 font-mono text-[#a6a097] whitespace-nowrap">
                            {row.current_step || "-"}
                          </td>
                          <td className="py-3 pr-4 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${statusPillStyle(
                                row.status
                              )}`}
                            >
                              {row.status}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-[#d6d2ca] leading-relaxed">
                            {row.outcome || "-"}
                          </td>
                          <td className="py-3 pr-4 text-[#a6a097]">
                            {row.next_action || "-"}
                          </td>
                          <td className="py-3 text-rose-300">{row.error_message || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-[#8f8980]">
                  No execution run yet. Confirm a staged workflow above to inspect live candidate routing.
                </div>
              ))}

            {activeTab === "candidates" && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#1f2229] text-[#8f8980]">
                      <th className="py-2.5 pr-4 font-medium">Candidate</th>
                      <th className="py-2.5 pr-4 font-medium">Role</th>
                      <th className="py-2.5 pr-4 font-medium">Resume Score</th>
                      <th className="py-2.5 pr-4 font-medium">Prescreen</th>
                      <th className="py-2.5 pr-4 font-medium">Notice</th>
                      <th className="py-2.5 font-medium">Interview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#191c22]">
                    {candidates.map((c) => (
                      <tr key={c.id} className="hover:bg-[#15181e]/80 transition">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-[#f7f5f0]">{c.name}</div>
                          <div className="text-[11px] text-[#7d776f]">{c.email}</div>
                        </td>
                        <td className="py-3 pr-4 text-[#cfc9c0]">{c.role}</td>
                        <td className="py-3 pr-4">
                          {c.resume_score !== null ? (
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-[#1e222b] rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-amber-300/90 rounded-full"
                                  style={{ width: `${Math.min(100, Math.max(0, c.resume_score))}%` }}
                                />
                              </div>
                              <span className="font-medium text-[#f2efe9]">{c.resume_score}</span>
                            </div>
                          ) : (
                            <span className="text-[#6d6860] italic">Missing</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {c.prescreen_passed === null ? (
                            <span className="text-[#6d6860]">Unknown</span>
                          ) : c.prescreen_passed ? (
                            <span className="text-emerald-300">Passed</span>
                          ) : (
                            <span className="text-rose-300">Failed</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-[#cfc9c0]">
                          {c.notice_period_days !== null ? `${c.notice_period_days}d` : "Unknown"}
                        </td>
                        <td className="py-3 font-medium text-[#f2efe9]">
                          {c.phone_interview_score ?? "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === "audit" && (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {auditLogs.length > 0 ? (
                  auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="bg-[#15181e] border border-[#222630] rounded-xl p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold text-amber-300/90">
                          {log.event_type}
                        </span>
                        <span className="text-[11px] text-[#7d776f]">
                          {new Date(log.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-[#dcd8d0]">{formatAuditSummary(log)}</div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-[#8f8980] py-4 text-center">
                    No audit entries recorded yet.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;