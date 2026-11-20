// Maps an evaluator outcome to the shape an ERC-8183-style job escrow expects:
// the evaluator either completes the job (pay the provider) or rejects it (refund the
// client), with a 32-byte reason. This module only translates; it does not talk to a chain.

const ACTIONS = {
  achieved: { action: "complete" },
  not_achieved: { action: "reject" },
  // Escrows of this kind are binary. A partial result should be modelled as milestone sub-objectives;
  // until then the safe default is to refuse payment and say why.
  partial: { action: "reject", note: "partial result: split the work into milestone objectives to pay for what was delivered" },
  needs_judgment: { action: "hold", note: "waiting for a named judge" },
  no_quorum: { action: "hold", note: "evaluators did not reach the threshold" },
};

/** `reasonHash` is the review's reviewHash, or a committee commitment. */
export function toEscrowAction(verdict, reasonHash) {
  const base = ACTIONS[verdict];
  if (!base) throw new Error(`unknown verdict ${verdict}`);
  if (!/^[0-9a-f]{64}$/.test(reasonHash ?? "")) throw new Error("reasonHash must be 64 lowercase hex characters");
  return { ...base, reason: `0x${reasonHash}` };
}
