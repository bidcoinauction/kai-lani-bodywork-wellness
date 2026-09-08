# Production Booking Reliability Incident

Status: **closed**. Final Production verification passed for deployment
`dpl_3PRkQeuUk5BPqtJPw3kitdqrX3PF` on `www.kailanibodywork.com`.

## Original Issues

- New-client Square customer creation defect. Resolved by `ce17c3b`.
- Required appointment-communications checkbox created unnecessary booking friction.
- Provider approval links expired after 2 hours.
- Expired requests could remain operationally confusing as pending holds.

## Final Corrections

- Corrected Square new-customer creation.
- Removed the required transactional communication checkbox.
- Retained explicit optional marketing consent.
- Increased approval TTL to 24 hours / 1440 minutes.
- Hardened expiration cleanup.
- Ensured expired requests release availability holds.
- Improved expired approval UX with clear 410 behavior.

## Production Proof

- New clients can submit without checking any boxes: **YES**.
- Overnight approval links remain valid the next morning: **YES**.
- Expired requests cannot continue blocking availability: **YES**.
- `npm test`: **322/322 passed**.
- `npm run build`: **passed**.
- Production commit: `8d040f81860cb9322ba7b232387a96500f04a1a5`.
- Production deployment: `dpl_3PRkQeuUk5BPqtJPw3kitdqrX3PF`.

## Historical Evidence Request

Request `4adfa6ae-613f-4382-87ef-7e565b117f86` is closed evidence of the
former 2-hour approval-window problem.

Final state:

- State: `expired`.
- Approval attempts: `0`.
- Active hold: `false`.
- Active blocking overlaps: `0`.
- Square customer: none.
- Square booking: none.

Do not modify, reset, retry, approve, decline, recover, or otherwise mutate this
historical request.

## Going Forward

- Do not perform additional speculative hardening.
- Allow normal Production traffic to exercise the workflow.
- If another booking issue occurs, investigate using the specific request
  reference and identify the first lifecycle divergence before making any code
  change.

Preserve this diagnostic sequence:

```text
request created
-> approval attempted
-> email search
-> phone search
-> customer creation/reuse
-> booking creation
-> confirmation
```

Diagnose the first missing or failed transition.
