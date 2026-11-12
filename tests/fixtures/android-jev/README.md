# Android Jev offline cases

Run `node --test tests/android-jev-recovery.test.js` from the repository root.
For waiting/escalation, also run `node --test tests/android-jev-wait-escalation.test.js`.

`cases.json` version 1 contains hand-authored inputs, transitions and expected writes.
The two completion cases use `tests/helpers/android-completion-world.cjs`; recovery
cases use `tests/helpers/android-search-world.cjs`. Both exercise the production
Service, raw XML evidence, policy gate and atomic receipts with injected devices
and model answers. No upstream requests or actual devices are used.

Cases assert the selected targets and write counts, not just matching outputs from
two identical runs. Keep old cases when adding a new policy version. A sanitized
production trace cannot reconstruct these worlds or their unobserved branches.

`waitCases` is an additive catalog for `search-v3`. It freezes virtual-clock
inputs and exact stop codes; each case asserts one model call and zero writes.
The waiting/escalation suite separately exercises raw loading markers, immutable
admission, actual Service leases, cancellation, partial progress and the production
JSONL store. The clock tests do not stand in for device timing or model quality.

`backCases` adds the `search-v8` same-window Back contract. Run
`node --test tests/android-jev-back.test.js`. The catalog fixes device writes,
terminal states and model counts for a panel-to-field transition, IME composition
and the original action budget. `android-search-actions-world.cjs` supplies the
synthetic panel, Back-to-form transition and independent query readback. The same
suite adds source/target safety, wrong-entry compensation, stale, assistance,
context drift and cancellation counterexamples. This remains a handwritten
control fixture, not production trace reconstruction or real-model evaluation.

`replay.json` is the J5.3 unified catalog for `search-v9`, `toggle-v1`,
`route-v1` and `ui-task-v20`. Run `node --test tests/android-jev-replay.test.js`. Cases are data
only (closed keys, effect and answer vocabularies, an existing source test and
declared de-identification transforms); `tests/helpers/android-jev-replay.cjs`
maps them onto the existing worlds. Each case asserts normalized device writes,
the world end state, stop code, atomic receipts, call counts, trace policy and
privacy. Completed cases with writes are re-run with every decision refused and
must diverge. Each family must keep normal, stale, hard-stop, unknown-write and
assistance coverage; a new task family adds its cases in the same batch.

The generic adapter `android-ui-task-replay.cjs` covers navigation/Back/Scroll,
host loading without model polling, stale, invalid response, unknown write,
main Agent, Handoff and cancellation. It uses only handwritten synthetic UI;
labels and named inputs may enter the injected generic model, but never durable
traces. Cancellation inspects the actual executor result after dependency drain,
even when the outer Service already rejected with STEP_ABORTED.

The v20 semantic variants remove resource IDs from the UI world. Exact raw descriptions bind the input and result text. Normal, stale and unknown-write paths share the same independent effect checks; successful variants also have refusal counterfactuals. These are offline placeholders, not model-quality samples.
