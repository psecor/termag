/**
 * Listening on REPLY_CHANNEL (services/askReplyBus.ts), over the process's one
 * LISTEN connection (services/pgListener.ts, which says why it is a dedicated
 * client on the writer endpoint and runs in every process, not only the lease
 * holder: a draining process can still be holding an asker's long poll). A
 * notification sent while that connection is down is missed; that reply is
 * lost to this process.
 */
import { REPLY_CHANNEL, ReplyAssembler } from './askReplyBus';
import { listen } from './pgListener';

let unlisten: (() => void) | null = null;

export function startReplyListener(onReply: (messageId: string, text: string) => void): void {
  if (unlisten) return;
  const assembler = new ReplyAssembler();
  unlisten = listen(REPLY_CHANNEL, {
    onPayload: payload => {
      const done = assembler.accept(payload);
      if (done) onReply(done.messageId, done.text);
    },
    missed: 'ask replies finished meanwhile miss this process',
  });
}

export function stopReplyListener(): void {
  unlisten?.();
  unlisten = null;
}
