'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';

const SESSION_ID_KEY = 'ahc-demo-session-id';
const HISTORY_KEY = 'ahc-demo-chat-history';

function readSessionId(): string {
  if (typeof window === 'undefined') return '';
  const existing = window.localStorage.getItem(SESSION_ID_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  window.localStorage.setItem(SESSION_ID_KEY, fresh);
  return fresh;
}

function readInitialMessages(): UIMessage[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as UIMessage[];
  } catch {
    // ignore corrupted history
  }
  return [];
}

function guessMediaTypeFromUrl(url: string): string {
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

export function Chat() {
  const sessionIdRef = useRef<string>('');
  const [hydrated, setHydrated] = useState(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);

  useEffect(() => {
    sessionIdRef.current = readSessionId();
    setInitialMessages(readInitialMessages());
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return <div className="m-auto text-sm text-gray-500">Loading…</div>;
  }

  return <ChatBody sessionIdRef={sessionIdRef} initialMessages={initialMessages} />;
}

function ChatBody({
  sessionIdRef,
  initialMessages,
}: {
  sessionIdRef: React.MutableRefObject<string>;
  initialMessages: UIMessage[];
}) {
  const transport = useRef(
    new DefaultChatTransport({
      api: '/api/chat',
      headers: () => ({ 'X-Session-Id': sessionIdRef.current }),
    }),
  );

  const chat = useChat({
    transport: transport.current,
    messages: initialMessages,
  });

  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  useEffect(() => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(chat.messages));
  }, [chat.messages]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (chat.status !== 'ready' && chat.status !== 'error') return;
    const trimmed = text.trim();
    if (!trimmed && !imageUrl) return;

    const files: FileUIPart[] = imageUrl.trim()
      ? [{ type: 'file', mediaType: guessMediaTypeFromUrl(imageUrl), url: imageUrl.trim() }]
      : [];

    void chat.sendMessage({ text: trimmed, files });
    setText('');
    setImageUrl('');
  };

  const onClear = () => {
    chat.setMessages([]);
    window.localStorage.removeItem(HISTORY_KEY);
  };

  return (
    <div className="flex h-full w-full">
      <section className="flex h-full min-w-0 flex-1 flex-col border-r border-gray-200 bg-white">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
          <h1 className="text-sm font-semibold text-gray-700">AHC Demo</h1>
          <button
            type="button"
            onClick={onClear}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            Clear
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {chat.messages.length === 0 ? (
            <p className="text-sm text-gray-400">No messages yet — say hi.</p>
          ) : (
            <ul className="space-y-3">
              {chat.messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
            </ul>
          )}
          {chat.error ? (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {chat.error.message}
            </p>
          ) : null}
        </div>
        <form onSubmit={onSubmit} className="border-t border-gray-200 p-3">
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="Image URL (optional)"
              className="rounded border border-gray-200 px-2 py-1 text-sm"
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Message…"
                className="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={chat.status !== 'ready' && chat.status !== 'error'}
                className="rounded bg-gray-900 px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                {chat.status === 'streaming' || chat.status === 'submitted' ? '…' : 'Send'}
              </button>
            </div>
          </div>
        </form>
      </section>
      <aside className="hidden h-full w-72 flex-col bg-gray-50 px-4 py-3 text-xs text-gray-600 md:flex">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">AHC Telemetry</h2>
        <p className="text-gray-400">Sidebar wires up in G3 — class/observations/scratchpad/tokens.</p>
      </aside>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UIMessage }) {
  const isUser = msg.role === 'user';
  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ${
          isUser ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-800'
        }`}
      >
        <div className="mb-1 text-[10px] uppercase tracking-wide opacity-60">{msg.role}</div>
        <div className="space-y-2 whitespace-pre-wrap break-words">
          {msg.parts.map((part, i) => renderPart(part, `${msg.id}-${i}`))}
        </div>
      </div>
    </li>
  );
}

function renderPart(part: UIMessage['parts'][number], key: string) {
  if (part.type === 'text') {
    return <span key={key}>{part.text}</span>;
  }
  if (part.type === 'file' && part.mediaType.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img key={key} src={part.url} alt="user-supplied" className="max-h-48 rounded border border-gray-200" />
    );
  }
  if (part.type === 'reasoning') {
    return (
      <pre key={key} className="rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
        reasoning: {part.text}
      </pre>
    );
  }
  if (part.type.startsWith('tool-')) {
    return (
      <pre key={key} className="rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
        {JSON.stringify(part, null, 2)}
      </pre>
    );
  }
  return null;
}
