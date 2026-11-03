// The head sampler is only the kill switch:
// record every span while server-tracing-enabled
// is on, nothing while it is off. Which recorded spans are exported is
// TraceBufferProcessor's decision, at the end of each entry.
import { trace, TraceFlags, type Context } from '@opentelemetry/api';
import { SamplingDecision, type Sampler, type SamplingResult } from '@opentelemetry/sdk-trace-base';
import { tracingEnabled } from './state';

export class KillSwitchSampler implements Sampler {
  constructor(private readonly enabled: () => boolean = tracingEnabled) {}

  shouldSample(ctx: Context): SamplingResult {
    if (!this.enabled()) return { decision: SamplingDecision.NOT_RECORD };
    // A child of a local span that isn't recorded (it started while the switch
    // was off) isn't either: it would have no entry to be decided with.
    const parent = trace.getSpanContext(ctx);
    if (parent && !parent.isRemote && !(parent.traceFlags & TraceFlags.SAMPLED)) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return { decision: SamplingDecision.RECORD_AND_SAMPLED };
  }

  toString(): string {
    return 'KillSwitchSampler';
  }
}
