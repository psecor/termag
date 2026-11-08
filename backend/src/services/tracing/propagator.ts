// An incoming traceparent is the caller's claim, so only a request that
// carries a credential continues it:
// termag's session cookie, the ALB's verified
// identity, or an Authorization header. Every other request (share links,
// sign-in callbacks, probes) starts a trace of its own. This is a presence
// check made before authentication runs; TraceBufferProcessor marks an entry
// that continued an incoming trace with termag.parent.remote, and decides it
// apart from any other entry under the same trace id.
//
// A caller's `tracestate` is dropped on the way in and never sent on, and
// nothing is injected into outbound calls unless the trace is recorded: with
// tracing off, no trace header leaves the process.
import { trace, TraceFlags, type Context, type TextMapGetter, type TextMapPropagator, type TextMapSetter } from '@opentelemetry/api';
import { SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../../auth/sessionCookie';

// Production's name and dev's (auth/sessionCookie.ts).
const SESSION_COOKIE_NAMES = [SESSION_COOKIE, LEGACY_SESSION_COOKIE];

function header(getter: TextMapGetter, carrier: unknown, name: string): string | undefined {
  const v = getter.get(carrier, name);
  return Array.isArray(v) ? v.join('; ') : v;
}

/** Whether the request's headers carry a credential that may continue an incoming trace. */
export function carriesCredential(getter: TextMapGetter, carrier: unknown): boolean {
  if (header(getter, carrier, 'authorization')) return true;
  if (header(getter, carrier, 'x-amzn-oidc-data')) return true;
  const cookie = header(getter, carrier, 'cookie') ?? '';
  return cookie.split(';').some(part => SESSION_COOKIE_NAMES.some(name => part.trim().startsWith(`${name}=`)));
}

/** The context with its span context's tracestate removed. */
function withoutTraceState(context: Context): Context {
  const span = trace.getSpanContext(context);
  return span?.traceState ? trace.setSpanContext(context, { ...span, traceState: undefined }) : context;
}

export class CredentialedParentPropagator implements TextMapPropagator {
  constructor(private readonly inner: TextMapPropagator) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const span = trace.getSpanContext(context);
    if (!span || !(span.traceFlags & TraceFlags.SAMPLED)) return;
    this.inner.inject(withoutTraceState(context), carrier, setter);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return carriesCredential(getter, carrier) ? withoutTraceState(this.inner.extract(context, carrier, getter)) : context;
  }

  fields(): string[] {
    return this.inner.fields();
  }
}
