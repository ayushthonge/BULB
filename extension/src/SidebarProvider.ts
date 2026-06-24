
import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;
    _doc?: vscode.TextDocument;

    constructor(private readonly _context: vscode.ExtensionContext) { }

    private getServerUrl(): string {
        return vscode.workspace.getConfiguration('socratic').get('serverUrl', 'http://localhost:3000');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'onInfo': {
                    if (!data.value) {
                        return;
                    }
                    vscode.window.showInformationMessage(data.value);
                    break;
                }
                case 'onError': {
                    if (!data.value) {
                        return;
                    }
                    vscode.window.showErrorMessage(data.value);
                    break;
                }
                case 'askAI': {
                    const editor = vscode.window.activeTextEditor;
                    let context = '';
                    if (editor) {
                        const selection = editor.selection;
                        if (!selection.isEmpty) {
                            context = editor.document.getText(selection);
                        } else {
                            context = editor.document.getText();
                        }
                    }

                    webviewView.webview.postMessage({
                        type: 'context-response',
                        value: context,
                        originalMessage: data.value
                    });
                    break;
                }
                case 'getToken': {
                    const token = this._context.globalState.get('socratic_token');
                    webviewView.webview.postMessage({
                        type: 'token-response',
                        value: token
                    });
                    break;
                }
            }
        });
    }

    public revive(panel: vscode.WebviewView) {
        this._view = panel;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview.js')
        );

        const nonce = getNonce();
        const serverUrl = this.getServerUrl();

        return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' ${serverUrl} http://localhost:3000;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Socratic AI</title>
      </head>
      <body>
        <script nonce="${nonce}">window.__SERVER_URL__ = '${serverUrl}';</script>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
