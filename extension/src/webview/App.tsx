
import React, { useState, useEffect, useRef } from 'react';
import './App.css';

declare global {
    interface Window {
        acquireVsCodeApi: () => any;
        __SERVER_URL__?: string;
    }
}

const vscode = window.acquireVsCodeApi();
const SERVER_URL = (window as any).__SERVER_URL__ || 'http://localhost:3000';

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderMessage(text: string) {
    // Escape first (defense-in-depth: tutor text is server-controlled and guard-
    // validated, but we never inject raw HTML), then apply the limited markdown.
    const html = escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br />');
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function App() {
    const [messages, setMessages] = useState<{ role: string, parts: string, type?: 'question' | 'resolution' }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [authToken, setAuthToken] = useState<string | null>(null);
    const [currentContext, setCurrentContext] = useState<string>('');
    const [contextHash, setContextHash] = useState<string>('');
    const [contextId, setContextId] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string>(() => generateSessionId());
    const [queryId, setQueryId] = useState<string | null>(null);
    const [isResolved, setIsResolved] = useState(false);
    const [resolutionHint, setResolutionHint] = useState<{ action?: string; frustration?: boolean } | null>(null);
    const [connected, setConnected] = useState<boolean | null>(null);
    const turnIndexRef = useRef<number>(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Connection status check
    useEffect(() => {
        const checkHealth = async () => {
            try {
                const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
                setConnected(res.ok);
            } catch {
                setConnected(false);
            }
        };
        checkHealth();
        const interval = setInterval(checkHealth, 30000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'context-response') {
                const context = message.value;
                const lineCount = context ? context.split('\n').length : 0;

                if (lineCount > 60) {
                    setMessages(prev => [...prev, {
                        role: 'assistant',
                        parts: `Your code is ${lineCount} lines long. Please select up to 60 lines to focus on. Highlight the relevant section in your editor and try again.`
                    }]);
                    setLoading(false);
                    return;
                }

                const hash = hashString(context);
                setCurrentContext(context);
                setContextHash(hash);

                const userPrompt = message.originalMessage;
                if (userPrompt) {
                    sendToBackend(userPrompt, context, hash);
                }
            } else if (message.type === 'token-response') {
                setAuthToken(message.value ? String(message.value) : null);
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [messages]);

    useEffect(() => {
        vscode.postMessage({ type: 'getToken' });
    }, []);

    function formatError(status: number, message: string): string {
        switch (status) {
            case 401: return "Authentication failed. Use Command Palette > 'Socratic: Set Auth Token'";
            case 413: return message || 'Code context is too large. Select a smaller portion (max 60 lines).';
            case 429: return 'Too many requests. Please wait a moment and try again.';
            case 500: return 'Server error. Please try again.';
            default: return message || 'Something went wrong.';
        }
    }

    const handleSend = () => {
        if (!input.trim() || isResolved) return;

        const newMessages = [...messages, { role: 'user', parts: input }];
        setMessages(newMessages);
        const currentInput = input;
        setInput('');
        setLoading(true);
        setError(null);
        setResolutionHint(null);
        turnIndexRef.current += 1;

        if (currentContext) {
            sendToBackend(currentInput, currentContext, contextHash, newMessages);
        } else {
            vscode.postMessage({
                type: 'askAI',
                value: currentInput
            });
        }
    };

    const startNewQuery = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${SERVER_URL}/query/start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                },
                body: JSON.stringify({
                    session_id: sessionId
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw Object.assign(new Error(errData.error || `Server Error: ${res.status}`), { status: res.status });
            }

            const data = await res.json();
            if (data.session_id && data.session_id !== sessionId) {
                setSessionId(data.session_id);
            }
            if (data.query_id) {
                setQueryId(data.query_id);
            }
            setMessages([]);
            setIsResolved(false);
            setResolutionHint(null);
            turnIndexRef.current = 0;
        } catch (err: any) {
            console.error('Start query error:', err);
            setError(err.status ? formatError(err.status, err.message) : 'Cannot reach the server. Check your internet connection.');
        } finally {
            setLoading(false);
        }
    };

    const sendToBackend = async (prompt: string, context: string, hash: string, historyOverride?: { role: string; parts: string }[]) => {
        try {
            const ensureQueryId = queryId || (await (async () => {
                const res = await fetch(`${SERVER_URL}/query/start`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                    },
                    body: JSON.stringify({ session_id: sessionId })
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw Object.assign(new Error(errData.error || `Server Error: ${res.status}`), { status: res.status });
                }
                const data = await res.json();
                if (data.session_id && data.session_id !== sessionId) {
                    setSessionId(data.session_id);
                }
                if (data.query_id) {
                    setQueryId(data.query_id);
                }
                return data.query_id as string;
            })());

            const res = await fetch(`${SERVER_URL}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                },
                body: JSON.stringify({
                    message: prompt,
                    context: context,
                    context_id: contextId,
                    context_hash: hash,
                    history: historyOverride || messages,
                    session_id: sessionId,
                    query_id: ensureQueryId,
                    turn_index: turnIndexRef.current
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw Object.assign(new Error(errData.error || `Server Error: ${res.status}`), { status: res.status });
            }

            const data = await res.json();

            if (data.session_id && data.session_id !== sessionId) {
                setSessionId(data.session_id);
            }
            if (data.query_id && data.query_id !== queryId) {
                setQueryId(data.query_id);
            }
            if (data.context_id && data.context_id !== contextId) {
                setContextId(data.context_id);
            }
            if (data.context_changed) {
                setContextHash(data.context_hash || contextHash);
            }

            if (data.response?.text) {
                setMessages(prev => [...prev, { role: 'assistant', parts: data.response.text, type: data.response.type }]);
                setError(null);
                if (data.response.type === 'resolution' || data.resolved) {
                    setIsResolved(true);
                    setResolutionHint(null);
                } else if (data.resolution) {
                    // Surface a soft confirm / supportive affordance based on the
                    // server's automatic resolution + frustration assessment.
                    setResolutionHint({
                        action: data.resolution.action,
                        frustration: data.resolution.frustration
                    });
                }
            }
        } catch (err: any) {
            console.error('Chat error:', err);
            const errorMsg = err.status
                ? formatError(err.status, err.message)
                : 'Cannot reach the server. Check your internet connection.';
            setMessages(prev => [...prev, { role: 'assistant', parts: `Error: ${errorMsg}` }]);
            setError(errorMsg);
        } finally {
            setLoading(false);
        }
    };

    const handleResolve = async () => {
        if (loading || messages.length === 0 || isResolved || !queryId) return;
        setLoading(true);
        setError(null);

        try {
            const res = await fetch(`${SERVER_URL}/query/resolve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    query_id: queryId
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw Object.assign(new Error(errData.error || `Server Error: ${res.status}`), { status: res.status });
            }

            const data = await res.json();
            if (data.response?.text) {
                setMessages(prev => [...prev, { role: 'assistant', parts: data.response.text, type: data.response.type }]);
            }
            setIsResolved(true);
            setResolutionHint(null);
        } catch (err: any) {
            console.error('Resolve error:', err);
            const errorMsg = err.status
                ? formatError(err.status, err.message)
                : 'Cannot reach the server. Check your internet connection.';
            setMessages(prev => [...prev, { role: 'assistant', parts: `Error: ${errorMsg}` }]);
            setError(errorMsg);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="app-container">
            <div className="app-header">
                <div className="header-left">
                    <div className="app-title">Socratic AI</div>
                    <span className={`status-dot ${connected === true ? 'status-connected' : connected === false ? 'status-disconnected' : 'status-unknown'}`} title={connected === true ? 'Connected' : connected === false ? 'Disconnected' : 'Checking...'} />
                </div>
                <div className="header-actions">
                    {messages.length > 0 && (
                        <button onClick={startNewQuery} className="new-query-btn" title="Start new query" disabled={loading}>
                            New Query
                        </button>
                    )}
                    {messages.length > 0 && (
                        <button onClick={handleResolve} className="resolve-btn" title="Mark as understood" disabled={loading || isResolved}>
                            I Understand
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="error-message">
                    {error}
                </div>
            )}

            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        {authToken ? (
                            <>
                                <div className="empty-state-title">How can I help you today?</div>
                                <div className="empty-state-description">
                                    Ask anything about the code you have open
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="empty-state-title">Set up your auth token</div>
                                <div className="empty-state-description">
                                    Use Command Palette (Ctrl+Shift+P) &gt; "Socratic: Set Auth Token" with the token provided by your instructor.
                                </div>
                            </>
                        )}
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div key={i} className={`message message-${m.role} ${m.type === 'resolution' ? 'message-resolution' : ''}`}>
                            <div className="message-bubble">
                                {renderMessage(m.parts)}
                            </div>
                        </div>
                    ))
                )}
                {loading && (
                    <div className="loading-indicator" aria-label="loading">
                        <span className="spinner" />
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {!isResolved && resolutionHint?.action === 'confirm_resolution' && (
                <div className="resolution-banner">
                    <span>Sounds like you’ve worked it out. Mark this query resolved?</span>
                    <button onClick={handleResolve} disabled={loading} className="resolution-banner-btn">
                        I’ve got it
                    </button>
                </div>
            )}
            {!isResolved && resolutionHint?.frustration && (
                <div className="frustration-banner">
                    Stuck is part of learning. Try the smallest version of the problem, or reach out to your
                    instructor — I’ll keep helping you reason it through.
                </div>
            )}

            <div className="input-container">
                <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    className="message-input"
                    placeholder={isResolved ? 'Query resolved. Click "New Query" to continue.' : 'Ask a question... (Shift+Enter for new line)'}
                    disabled={loading || isResolved}
                    rows={2}
                />
                <button onClick={handleSend} disabled={loading || !input.trim() || isResolved} className="send-button">
                    {loading ? 'Sending...' : 'Send'}
                </button>
            </div>
        </div>
    );
}

function generateSessionId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 10);
}

function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}
