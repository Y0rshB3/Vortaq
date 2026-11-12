/**
 * The extension's notifications. In a non-modal show*Message the editor turns
 * `[text](target)` into a link it opens when clicked, `command:` targets
 * included, which run editor commands (the terminal's too). These texts often
 * carry words the extension does not control (a server's error message and
 * its details, a file name, an object name), so the link syntax is always
 * broken up first: a zero-width space between `]` and `(` keeps the text the
 * same to read and makes it plain text to the editor.
 */
import * as vscode from 'vscode'

export function plainNoticeText(text: string): string {
  return text.replace(/\](\s*)\(/g, ']$1\u200b(')
}

type Show = typeof vscode.window.showErrorMessage

const plain = (show: () => Show): Show =>
  ((message: string, ...rest: unknown[]) =>
    show()(plainNoticeText(String(message)), ...(rest as []))) as Show

/** vscode.window.showErrorMessage with link syntax made plain text. */
export const showError: Show = plain(() => vscode.window.showErrorMessage)
/** vscode.window.showWarningMessage with link syntax made plain text. */
export const showWarning: typeof vscode.window.showWarningMessage = plain(
  () => vscode.window.showWarningMessage
) as typeof vscode.window.showWarningMessage
/** vscode.window.showInformationMessage with link syntax made plain text. */
export const showInformation: typeof vscode.window.showInformationMessage = plain(
  () => vscode.window.showInformationMessage
) as typeof vscode.window.showInformationMessage
