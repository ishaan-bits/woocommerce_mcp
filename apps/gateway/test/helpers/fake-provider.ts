import type { ChatProvider, ProviderRequest, ProviderResponse, ProviderToolCall } from "../../src/agent/provider.ts";
import { ProviderError } from "../../src/agent/provider.ts";

/**
 * Deterministic scripted provider for Milestone 9 tests — a clearly labelled
 * TEST DOUBLE, never a real model. Each `complete()` call consumes one turn.
 */
export interface ScriptedToolCall {
  name: string;
  /** Either parsed arguments or a raw string (set raw=true to feed malformed JSON). */
  arguments?: Record<string, unknown> | string;
  id?: string;
}

export interface ScriptedTurn {
  content?: string;
  toolCalls?: ScriptedToolCall[];
  /** Throw this ProviderError instead of responding. */
  error?: ProviderError;
}

export class ScriptedProvider implements ChatProvider {
  readonly model = "scripted-test-double";
  label = "scripted";
  readonly requests: ProviderRequest[] = [];
  private readonly queue: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.queue = [...turns];
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const turn = this.queue.shift();
    if (turn === undefined) {
      throw new Error("ScriptedProvider: no scripted turn remaining");
    }
    if (turn.error !== undefined) {
      throw turn.error;
    }
    const toolCalls: ProviderToolCall[] = (turn.toolCalls ?? []).map((call, index) => {
      const raw = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      const parsedArgs =
        typeof call.arguments === "object" && call.arguments !== null ? (call.arguments as Record<string, unknown>) : {};
      return {
        id: call.id ?? `call_${index}`,
        name: call.name,
        arguments: parsedArgs,
        rawArguments: raw,
      };
    });
    return { content: turn.content ?? null, toolCalls };
  }
}
