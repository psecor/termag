import { describe, it, expect, vi } from 'vitest';
import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { RPCType, setRPCMetadata } from '@opentelemetry/core';
import { bindServerSpan, setServerSpanAttributes } from './requestSpan';

const fakeSpan = (recording = true) => ({ isRecording: () => recording, setAttributes: vi.fn() }) as unknown as Span & { setAttributes: ReturnType<typeof vi.fn> };
const contextFor = (span: Span) => setRPCMetadata(ROOT_CONTEXT, { type: RPCType.HTTP, span });

describe('request attributes', () => {
  it('land on the span bound first, not on whichever request a later context belongs to', () => {
    const mine = fakeSpan();
    const other = fakeSpan();
    const req = {};
    bindServerSpan(req, contextFor(mine));
    // After the session stack the active context can be another request's.
    bindServerSpan(req, contextFor(other));
    setServerSpanAttributes(req, { 'termag.user': 'u1' });
    expect(mine.setAttributes).toHaveBeenCalledWith({ 'termag.user': 'u1' });
    expect(other.setAttributes).not.toHaveBeenCalled();
  });

  it('do nothing for a request with no server span, or one that is not recording', () => {
    expect(() => setServerSpanAttributes({}, { 'termag.user': 'u1' })).not.toThrow();
    const idle = fakeSpan(false);
    const req = {};
    bindServerSpan(req, contextFor(idle));
    setServerSpanAttributes(req, { 'termag.user': 'u1' });
    expect(idle.setAttributes).not.toHaveBeenCalled();
  });

  it('bind nothing outside a traced request', () => {
    const req = {};
    bindServerSpan(req, ROOT_CONTEXT);
    const later = fakeSpan();
    bindServerSpan(req, contextFor(later));
    setServerSpanAttributes(req, { 'termag.surface': 'web' });
    expect(later.setAttributes).toHaveBeenCalledWith({ 'termag.surface': 'web' });
  });
});
