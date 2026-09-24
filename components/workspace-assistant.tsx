"use client";

import { useUser } from "@clerk/nextjs";
import { Bot, LoaderCircle, MessageCircle, Send, Trash2, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import ChatMarkdown from "@/components/chat-markdown";

type Message = { role: "user" | "assistant"; content: string; sources?: string[] };

export default function WorkspaceAssistant() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedStorageKey, setLoadedStorageKey] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const storageKey = user?.id ? `testit-workspace-chat:${user.id}` : "";

  useEffect(() => {
    if (!storageKey) return;
    setLoadedStorageKey("");
    try { setMessages(JSON.parse(localStorage.getItem(storageKey) || "[]") as Message[]); }
    catch { setMessages([]); }
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (storageKey && loadedStorageKey === storageKey) localStorage.setItem(storageKey, JSON.stringify(messages.slice(-40)));
  }, [storageKey, loadedStorageKey, messages]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [open, messages, busy]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || busy) return;
    const history = messages.slice(-8).map(({ role, content }) => ({ role, content }));
    setQuestion("");
    setMessages((current) => [...current, { role: "user", content: prompt }]);
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, history }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not answer that question.");
      setMessages((current) => [...current, { role: "assistant", content: data.answer, sources: data.sources }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "Could not answer that question." }]);
    } finally { setBusy(false); }
  }

  return <>
    {open && <aside className="workspace-assistant-panel" aria-label="Workspace repository chat">
      <header><span className="workspace-assistant-icon"><Bot size={17} /></span><div><strong>Workspace assistant</strong><small>Ask across analyzed repositories</small></div>
        <button type="button" aria-label="Clear chat" onClick={() => setMessages([])}><Trash2 size={15} /></button>
        <button type="button" aria-label="Close chat" onClick={() => setOpen(false)}><X size={17} /></button>
      </header>
      <div className="workspace-assistant-messages" aria-live="polite">
        {!messages.length && <div className="workspace-assistant-empty"><Bot size={22} /><p>Ask about code or tests across every repository you’ve analyzed.</p><small>Answers include repository and file citations.</small></div>}
        {messages.map((message, index) => <article className={`repo-chat-message ${message.role}`} key={`${message.role}-${index}`}>
          <span className="repo-chat-avatar">{message.role === "assistant" ? <Bot size={15} /> : <UserRound size={15} />}</span>
          <div className="repo-chat-bubble">{message.role === "assistant" ? <ChatMarkdown content={message.content} /> : <p>{message.content}</p>}{message.sources?.length ? <small>Sources: {message.sources.join(" · ")}</small> : null}</div>
        </article>)}
        {busy && <div className="repo-chat-message assistant"><span className="repo-chat-avatar"><Bot size={15} /></span><div className="repo-chat-bubble repo-chat-thinking"><LoaderCircle className="repo-spinner" size={14} /> Searching analyzed repositories…</div></div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={(event) => void send(event)}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about your repositories…" aria-label="Ask across analyzed repositories" /><button disabled={!question.trim() || busy} aria-label="Send message"><Send size={15} /></button></form>
    </aside>}
    <button type="button" className={`workspace-assistant-launcher ${open ? "open" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      {open ? <X size={19} /> : <MessageCircle size={19} />}<span>{open ? "Close assistant" : "Ask your repos"}</span>
    </button>
  </>;
}
