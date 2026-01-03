
import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Socratic AI Extension is now active!');

    const sidebarProvider = new SidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "socratic.chatView",
            sidebarProvider
        )
    );

    let openChatDisposable = vscode.commands.registerCommand('socratic.openChat', () => {
        vscode.commands.executeCommand('socratic.chatView.focus');
    });

    let openChatRightDisposable = vscode.commands.registerCommand('socratic.openChatRight', async () => {
        // Focus our container and move the whole container to the secondary (right) sidebar
        await vscode.commands.executeCommand('socratic.chatView.focus');
        await vscode.commands.executeCommand('workbench.action.moveViewContainerToSecondarySideBar');
        // Ensure the right sidebar is visible and focus our view again
        await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
        await vscode.commands.executeCommand('socratic.chatView.focus');
    });

    let disposable = vscode.commands.registerCommand('socratic.ask', () => {
        vscode.window.showInformationMessage('Open Socratic Sidebar to chat!');
    });

    let tokenDisposable = vscode.commands.registerCommand('socratic.setToken', async () => {
        const token = await vscode.window.showInputBox({
            placeHolder: 'Enter your Socratic Auth Token',
            password: true
        });
        if (token) {
            await context.globalState.update('socratic_token', token.trim());
            vscode.window.showInformationMessage('Token saved!');
            // Notify webview if possible, or webview asks for it.
        }
    });

    context.subscriptions.push(openChatDisposable);
    context.subscriptions.push(openChatRightDisposable);
    context.subscriptions.push(disposable);
    context.subscriptions.push(tokenDisposable);
}

export function deactivate() { }
