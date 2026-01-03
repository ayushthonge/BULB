
import React, { useState, useEffect, useRef } from 'react';
import './App.css';

declare global {
    interface Window {
        acquireVsCodeApi: () => any;
    }
}

const vscode = window.acquireVsCodeApi();

export default function App() {
    const [messages, setMessages] = useState<{ role: string, parts: string }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentContext, setCurrentContext] = useState<string>('');
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
                setCurrentContext(context);
                const userPrompt = message.originalMessage;
                if (userPrompt) {
                    sendToBackend(userPrompt, context);
                }
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [messages]);

    const handleSend = () => {
        if (!input.trim()) return;

        const newMessages = [...messages, { role: 'user', parts: input }];
        setMessages(newMessages);
        const currentInput = input;
        setInput('');
        setLoading(true);
        setError(null);

        // If we have context, send immediately. Otherwise ask for it.
        if (currentContext) {
            sendToBackend(currentInput, currentContext);
        } else {
            vscode.postMessage({
                type: 'askAI',
                value: currentInput
            });
        }
    };

    const sendToBackend = async (prompt: string, context: string) => {
        try {
            const res = await fetch('http://localhost:3000/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: prompt,
                    context: context,
                    history: messages
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errData.error || `Server Error: ${res.status}`);
            }

            const data = await res.json();

            if (data.response) {
                setMessages(prev => [...prev, { role: 'assistant', parts: data.response }]);
                setError(null);
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

    const clearChat = () => {
        setMessages([]);
        setError(null);
    };

    return (
        <div className="app-container">
            <div className="app-header">
                <div className="header-left">
                    <div className="app-title">Socratic AI</div>
                </div>
                <div className="header-actions">
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
                        <div key={i} className={`message message-${m.role}`}>
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
                    placeholder="Ask a question... (Shift+Enter for new line)"
                    disabled={loading}
                    rows={2}
                />
                <button onClick={handleSend} disabled={loading || !input.trim()} className="send-button">
                    {loading ? 'Sending...' : 'Send'}
                </button>
            </div>
        </div>
    );
}
