# 🧠 Socratic AI - Project Summary

## Overview

**Socratic AI** is a Visual Studio Code extension that provides an AI-powered coding assistant using the Socratic teaching method. Instead of directly providing solutions, it guides developers through problems by asking thoughtful questions, helping them learn and understand concepts more deeply.

## Project Architecture

The project consists of three main components:

### 1. **VS Code Extension** (`extension/`)

- **Framework**: TypeScript with React for webview UI
- **Entry Point**: `src/extension.ts`
- **Main Components**:
  - `SidebarProvider.ts` - Manages the webview sidebar interface
  - `webview/App.tsx` - React-based chat interface
  - Custom sidebar view container with duck icon
- **Features**:
  - Chat interface in VS Code sidebar
  - Context grabbing from active editor
  - Keyboard shortcuts (Ctrl+Shift+A)
  - Authentication token management
  - Commands for opening chat in different views

### 2. **Backend Server** (`server/`)

- **Framework**: Fastify (Node.js)
- **AI Integration**: Google Gemini 2.5 Flash Lite
- **Main Components**:
  - `index.ts` - Fastify server with CORS enabled
  - `gemini.ts` - AI chat logic with retry mechanism
  - `auth.ts` - Authentication handlers (currently disabled for testing)
  - `metrics.ts` - Prometheus metrics for monitoring
  - `systemPrompt.ts` - Socratic teaching prompt configuration
  - `supabase.ts` - Database integration
- **Endpoints**:
  - `POST /chat` - Main chat endpoint
  - `POST /summary` - Generate session summaries
  - `GET /metrics` - Prometheus metrics
  - `GET /health` - Health check

### 3. **Auth Token Generator** (`auth_token_generator/`)

- Simple utility for generating authentication tokens
- Contains `token.js` for token generation

## Key Features

### 🎓 Socratic Teaching Method

- AI asks guiding questions instead of providing direct answers
- Helps developers think through problems independently
- Encourages deeper understanding of concepts

### 📋 Context-Aware Assistance

- "Grab Current File Context" button captures active code
- Sends file content to AI for contextual guidance
- Maintains conversation history for continuity

### 🔄 Robust Error Handling

- **Auto-retry logic**: Up to 3 attempts with exponential backoff (1s, 2s, 4s)
- Handles Google API overload gracefully
- Clear error messages for debugging

### 💬 Modern UI

- Clean React-based chat interface
- Styled with CSS for professional appearance
- Auto-scrolling message feed
- Loading states and error displays

### 📊 Monitoring & Metrics

- Prometheus metrics integration
- Performance tracking
- Health check endpoints

## Technology Stack

### Extension

- TypeScript 5.3+
- React 18.2
- Webpack 5 for bundling
- VS Code Extension API 1.85+
- Axios for HTTP requests

### Server

- Node.js with TypeScript
- Fastify 4.26 (high-performance web framework)
- Google Generative AI SDK (@google/generative-ai)
- Supabase for database
- Prometheus client for metrics
- CORS enabled for cross-origin requests
- ts-node-dev for development

## Development Workflow

### Setup & Running

**Backend Server:**

```powershell
cd server
npm install
npm run dev  # Start development server on port 3000
```

**Extension Development:**

```powershell
cd extension
npm install
npm run watch  # Watch mode for auto-compilation
# Press F5 in VS Code to launch Extension Development Host
```

### Available Scripts

**Server:**

- `npm run dev` - Start development server
- `npm run build` - Compile TypeScript
- `npm run start` - Run compiled server
- `npm run test-chat` - Test chat functionality
- `npm run test-gemini-chat` - Test Gemini integration
- `npm run test-gemini-direct` - Direct Gemini API test

**Extension:**

- `npm run compile` - Build extension
- `npm run watch` - Watch mode for development
- `npm run package` - Production build
- `npm run lint` - ESLint checks

## Project Configuration

### Extension Configuration

- **Name**: `socratic-ai-extension`
- **Display Name**: Socratic AI Assistant
- **Version**: 0.0.1
- **Activation**: On demand
- **View Container**: Custom sidebar with duck icon
- **Commands**:
  - `socratic.openChat` - Open chat in sidebar
  - `socratic.openChatRight` - Open chat in right sidebar
  - `socratic.ask` - Quick ask command
  - `socratic.setToken` - Set authentication token

### Server Configuration

- **Port**: 3000
- **Host**: 0.0.0.0 (accessible from network)
- **AI Model**: Gemini 2.5 Flash Lite
- **CORS**: Enabled for all origins (\*)
- **Authentication**: Currently disabled for testing

## AI Integration Details

### Gemini Configuration

- Model: `gemini-2.5-flash-lite`
- Uses custom system prompt for Socratic teaching
- Features text sanitization to ensure single-question responses
- Implements smart retry mechanism with exponential backoff

### Response Processing

- Sanitizes AI responses to extract single questions
- Limits question length to 20 words
- Ensures proper question formatting
- Fallback to default question if parsing fails

## Data Flow

1. User types message in VS Code sidebar
2. (Optional) User clicks "Grab Context" to include current file
3. Extension sends message + context + history to backend
4. Backend forwards to Gemini API with system prompt
5. Gemini generates Socratic question
6. Response sanitized and returned to extension
7. Extension displays in chat UI

## Security Considerations

- Authentication currently disabled for testing
- Token management infrastructure in place
- Environment variables for API keys
- Secret files excluded from version control (`secrets.txt`, `token*.txt`)

## Monitoring & Observability

- Prometheus metrics endpoint at `/metrics`
- Health check endpoint at `/health`
- Detailed logging in Fastify
- Error tracking with stack traces
- Request/response logging

## Development Status

- **Version**: 0.0.1 (Early development)
- **Authentication**: Disabled for testing
- **Deployment**: Local development only
- **Database**: Supabase integration prepared but not fully implemented

## Future Improvements

Potential areas for enhancement:

- Enable authentication for production use
- Implement session persistence with Supabase
- Add conversation history management
- Implement rate limiting
- Add more AI models/providers
- Enhance error handling and user feedback
- Add unit and integration tests
- Package for VS Code marketplace

## File Structure Highlights

```
BULB/
├── extension/              # VS Code Extension
│   ├── src/
│   │   ├── extension.ts    # Main extension entry
│   │   ├── SidebarProvider.ts  # Webview provider
│   │   └── webview/        # React UI
│   ├── resources/          # Icons and assets
│   └── package.json
├── server/                 # Backend API
│   ├── src/
│   │   ├── index.ts        # Fastify server
│   │   ├── gemini.ts       # AI integration
│   │   ├── auth.ts         # Authentication
│   │   ├── metrics.ts      # Monitoring
│   │   └── scripts/        # Testing utilities
│   └── package.json
├── auth_token_generator/   # Token generation utility
└── README.md              # User-facing documentation
```

## Quick Start Summary

1. **Clone and install**: Run `npm install` in both `extension/` and `server/`
2. **Start backend**: `cd server && npm run dev`
3. **Launch extension**: Open `extension/` in VS Code, press F5
4. **Use extension**: Click sidebar icon, grab context, ask questions
5. **Get Socratic guidance**: AI asks questions to guide your learning

---

**Project Type**: VS Code Extension with AI Integration  
**Primary Language**: TypeScript  
**AI Provider**: Google Gemini  
**Teaching Method**: Socratic Questioning  
**Status**: Active Development
