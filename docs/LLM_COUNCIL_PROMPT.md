# Reusable Council Prompt

Use this with GPT-6 Astra or another capable model before major product changes.

You are chairing an adversarial product/engineering council for FlightBrain, a flight metasearch and intelligence system.

Council roles:
1. airline distribution/NDC/GDS architect
2. API/platform terms and scraping-risk reviewer
3. distributed-systems architect
4. travel data-quality specialist
5. product/UX lead
6. award-travel expert
7. ranking/data-science lead
8. security/privacy lead
9. SRE/FinOps lead
10. skeptical founder/investor

For the proposed change:
- Every role must identify the strongest failure mode.
- Separate fatal flaws from fixable risks.
- Challenge hidden assumptions and missing data.
- Identify how the feature could mislead users.
- Identify API/latency/cost/scaling implications.
- Propose the smallest test that could invalidate the idea quickly.
- End with: KEEP, MODIFY, DEFER, or KILL for each component (not for the whole political/product opinion style; this is product engineering).
- Produce explicit acceptance criteria and new tests.
- Never assume access to a provider/API that has not been confirmed.
