
import React, { useState, useEffect, useRef } from 'react';
import './App.css';

declare global {
    interface Window {
        acquireVsCodeApi: () => any;
    }
}

const vscode = window.acquireVsCodeApi();

export default function App() {
    const [messages, setMessages] = useState<{ role: string, parts: string, type?: 'question' | 'resolution' }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentContext, setCurrentContext] = useState<string>('');
    const [contextHash, setContextHash] = useState<string>('');
    const [contextId, setContextId] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string>(() => generateSessionId());
    const [queryId, setQueryId] = useState<string | null>(null);
    const [isResolved, setIsResolved] = useState(false);
    const turnIndexRef = useRef<number>(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'context-response') {
                const context = message.value;
                const hash = hashString(context);
                
                setCurrentContext(context);
                setContextHash(hash);
                
                const userPrompt = message.originalMessage;
                if (userPrompt) {
                    sendToBackend(userPrompt, context, hash);
                }
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [messages]);

    const handleSend = () => {
        if (!input.trim() || isResolved) return;

        const newMessages = [...messages, { role: 'user', parts: input }];
        setMessages(newMessages);
        const currentInput = input;
        setInput('');
        setLoading(true);
        setError(null);
        turnIndexRef.current += 1;

        // If we have context, send immediately. Otherwise ask for it.
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
            const res = await fetch('http://localhost:3000/query/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: sessionId
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errData.error || `Server Error: ${res.status}`);
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
            turnIndexRef.current = 0;
        } catch (err: any) {
            console.error('Start query error:', err);
            setError(err.message || 'Failed to start new query');
        } finally {
            setLoading(false);
        }
    };

    const sendToBackend = async (prompt: string, context: string, hash: string, historyOverride?: { role: string; parts: string }[]) => {
        try {
            const ensureQueryId = queryId || (await (async () => {
                const res = await fetch('http://localhost:3000/query/start', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ session_id: sessionId })
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(errData.error || `Server Error: ${res.status}`);
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

            const res = await fetch('http://localhost:3000/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
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
                throw new Error(errData.error || `Server Error: ${res.status}`);
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
                // Server regenerated summary, update hash
                setContextHash(data.context_hash || contextHash);
            }

            if (data.response?.text) {
                setMessages(prev => [...prev, { role: 'assistant', parts: data.response.text, type: data.response.type }]);
                setError(null);
                if (data.response.type === 'resolution') {
                    setIsResolved(true);
                }
            }
        } catch (err: any) {
            console.error('Chat error:', err);
            const errorMsg = err.message || 'Connection failed';
            setMessages(prev => [...prev, { role: 'assistant', parts: `Error: ${errorMsg}\n\nMake sure the backend server is running on http://localhost:3000` }]);
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
            const res = await fetch('http://localhost:3000/query/resolve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    query_id: queryId
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errData.error || `Server Error: ${res.status}`);
            }

            const data = await res.json();
            if (data.response?.text) {
                setMessages(prev => [...prev, { role: 'assistant', parts: data.response.text, type: data.response.type }]);
            }
            if (data.summary) {
                setMessages(prev => [...prev, { role: 'assistant', parts: `Summary: ${JSON.stringify(data.summary, null, 2)}`, type: 'resolution' }]);
            }
            setIsResolved(true);
        } catch (err: any) {
            console.error('Resolve error:', err);
            const errorMsg = err.message || 'Resolution failed';
            setMessages(prev => [...prev, { role: 'assistant', parts: `Error: ${errorMsg}` }]);
            setError(errorMsg);
        } finally {
            setLoading(false);
        }
    };

    const clearChat = () => {
        setMessages([]);
        setError(null);
        turnIndexRef.current = 0;
        setQueryId(null);
        setContextId(null);
        setContextHash('');
        setIsResolved(false);
    };

    return (
        <div className="app-container">
            <div className="app-header">
                <div className="header-left">
                    <div className="app-title">Socratic AI</div>
                </div>
                <div className="header-actions">
                    {messages.length > 0 && (
                        <button onClick={startNewQuery} className="new-query-btn" title="Start new query" disabled={loading}>
                            New Query
                        </button>
                    )}
                    {messages.length > 0 && (
                        <button onClick={handleResolve} className="resolve-btn" title="Mark query resolved" disabled={loading || isResolved}>
                            Query Resolved
                        </button>
                    )}
                    {messages.length > 0 && (
                        <button onClick={clearChat} className="clear-btn" title="Clear chat">
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="error-message">
                    Error: {error}
                </div>
            )}

            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-title">How can I help you today?</div>
                        <div className="empty-state-description">
                            Ask anything about the code you have open
                        </div>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div key={i} className={`message message-${m.role} ${m.type === 'resolution' ? 'message-resolution' : ''}`}>
                            <div className="message-bubble">
                                {m.parts}
                            </div>
                        </div>
                    ))
                )}
                {loading && <div className="loading-indicator">Thinking...</div>}
                <div ref={messagesEndRef} />
            </div>

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
                    placeholder={isResolved ? 'This conversation is resolved. Clear to start a new one.' : 'Ask a question... (Shift+Enter for new line)'}
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
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}
