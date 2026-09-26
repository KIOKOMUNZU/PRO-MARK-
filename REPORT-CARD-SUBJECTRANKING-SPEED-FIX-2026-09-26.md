# PRO-MARK Report Card Subject Ranking + Speed Fix — 2026-09-26

## Critical correction
Fixed the `Cannot access 'subjectRanking' before initialization` JavaScript temporal-dead-zone error in `backend/services/report-engine.js`.

The report engine was reading `subjectRanking` before its `const` declaration. This caused report-card actions to fail before the report could be returned/rendered.

The premature read was removed. Subject ranks are still assigned from the class ranking query before the final `subject_ranking` payload is built.

## Speed improvement
The current subject-ranking query and prior-year subject-history query are independent, so they now execute concurrently with `Promise.all()` rather than sequentially. This reduces avoidable database round-trip time for report-card opens.

## Preservation
This fix keeps the existing project structure and functionality intact. No learner, mark-entry, assessment, merit, billing, authentication, or database schema functionality was removed.
