PRO-MARK 3.9.6 - COMPLETE MARK ENTRY FIX

This build fixes the error:
"Cannot read properties of undefined (reading 'assignment_id')"

Changes:
1. Assessment is no longer cleared when Class/Subject is selected.
2. Mark Entry assignment loading is asynchronous and correctly awaits the roster.
3. Save Marks no longer assumes r.assignment.assignment_id exists without checking.
4. Added POST /api/assessments/:schoolId/marks/save for bulk teacher saving.
5. Bulk save validates the teacher's assignment, class, subject, year and assessment.
6. The current teacher_subject_assignments schema is treated as term-independent;
   the selected assessment supplies the term_id for marks.
7. Teacher assignment retrieval no longer joins the nonexistent tsa.term_id.
8. Assessment/subject filtering no longer requires tsa.term_id.
9. Existing authentication and school-boundary checks are retained.

TEST:
Year -> Term -> Assessment -> Class -> Subject -> enter marks -> SAVE MARK SHEET.

INSTALL:
Keep your existing .env/database configuration. Replace the project files with
this ZIP, then start Node and hard-refresh the browser with Ctrl+F5.
