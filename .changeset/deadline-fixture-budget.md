---
---

Give the real-HTTP body-stage timeout fixture enough time to finish request
authorization, audit, and connection setup on busy CI runners. It still requires
a target 200 followed by a real Gateway deadline, failed body consumption, and a
timeout report/audit event. The pre-header 504 test keeps its short deadline;
production timeout defaults and behavior are unchanged.
