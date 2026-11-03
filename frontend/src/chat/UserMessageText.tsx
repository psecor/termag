// A message the person sent, as its bubble shows it. A message sent from a
// space file's composer ends with a "(viewing space:path)" line
// (chat/fileChat.ts fileChatMessage): the conversation draws that line
// quieter than what was typed, live and from the history alike.
import React from 'react';
import { splitViewingLine } from './fileChat';
import '../pages/chat/fileChat.css';

export function UserMessageText({ text }: { text: string }) {
  const { body, viewing } = splitViewingLine(text);
  if (!viewing) return <>{text}</>;
  return <>{body}{body && '\n'}<span className="sdk-user-context">{viewing}</span></>;
}
