// A send's id: the browser names a message it may send again (a new
// session's first message, held in its queue until a send of it is
// answered). The chat runner keeps the answer it gave each id, per chat, in
// `<chat>.sends.json`, and answers a repeat of the id with that answer
// instead of taking the message a second time. So a chat-send whose answer
// never reaches the browser (the orchestrator stops waiting while the box
// goes on to start the turn) is safe to send again. A queued or live message
// carries its id, and one dropped before it reached Claude (Stop, a cleared
// chat) is forgotten, so sending it again takes it again.

const SEND_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Answers kept per chat, newest last. */
const SEND_IDS_MAX = 20;

function isSendId(v) {
  return typeof v === 'string' && SEND_ID_RE.test(v);
}

/** The answer given for `id`, or null when this chat took no send with it. */
function sentAnswer(list, id) {
  if (!Array.isArray(list)) return null;
  const hit = list.find(e => e && e.id === id && e.answer && typeof e.answer === 'object');
  return hit ? hit.answer : null;
}

/** `list` with `id`'s answer added, keeping the newest SEND_IDS_MAX. */
function withSent(list, id, answer) {
  const kept = Array.isArray(list) ? list.filter(e => e && isSendId(e.id) && e.id !== id) : [];
  return [...kept, { id, answer }].slice(-SEND_IDS_MAX);
}

/** `list` without `ids`: sends whose message was dropped before it reached Claude (Stop, a cleared chat). */
function withoutSent(list, ids) {
  const gone = new Set(ids);
  return Array.isArray(list) ? list.filter(e => e && isSendId(e.id) && !gone.has(e.id)) : [];
}

module.exports = { isSendId, sentAnswer, withSent, withoutSent, SEND_IDS_MAX };
