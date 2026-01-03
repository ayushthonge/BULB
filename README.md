# 🧠 Socratic AI - VS Code Extension

A VS Code extension that guides you through coding problems using Socratic questioning.

## 🚀 Quick Setup

### 1. Start the Backend
```powershell
cd server
npm install
npm run dev
```
**Keep this terminal running!**

### 2. Launch Extension
- Open `extension` folder in VS Code
- Press **F5**
- Extension Development Host window will open

### 3. Use the Extension
1. Click "📋 Grab Current File Context" button to capture your code
2. Type your question
3. Press Send
4. Get Socratic guidance!

## ✨ Features

- 🎓 **Socratic Method**: AI asks guiding questions instead of giving direct answers
- 📋 **Easy Context**: One-click button to grab your current file
- 💬 **Clean UI**: Modern, responsive chat interface
- 🚀 **No Auth Required**: Simplified for quick testing

## 🔧 Quick Commands

```powershell
# Backend
cd server
npm run dev              # Start server
npm run test-gemini-chat # Test AI connection

# Extension
cd extension
npm run compile          # Build extension
```

## 🐛 Troubleshooting

**Error: "Connection failed"**
→ Make sure backend server is running (`npm run dev` in server folder)

**Error: "Google's AI is currently overloaded"**
→ This is temporary! The code automatically retries with exponential backoff (1s, 2s, 4s)
→ Usually resolves within 30-60 seconds
→ Just wait a moment and try again

**UI looks broken**
→ Run `npm run compile` in extension folder, then reload extension (Ctrl+R)

**No response from AI**
→ Check server terminal for errors

---

## 💡 Features

- **Auto-Retry Logic**: If Google's API is overloaded, automatically retries up to 3 times
- **Smart Backoff**: Waits 1s, then 2s, then 4s between retries
- **Clear Error Messages**: Know exactly what's happening

---

That's it! Simple and ready to use. 🎉
