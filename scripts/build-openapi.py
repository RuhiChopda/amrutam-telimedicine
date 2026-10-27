#!/usr/bin/env python3
"""Generates docs/openapi.yaml (source of truth is this compact definition; the CI drift check keeps it honest)."""
import yaml
SEC=[{"bearerAuth":[]}]
def ref(n): return {"$ref":f"#/components/schemas/{n}"}
def body(n): return {"required":True,"content":{"application/json":{"schema":ref(n)}}}
def ok(desc="OK",schema=None,code="200"):
    r={"description":desc}
    if schema: r["content"]={"application/json":{"schema":schema}}
    return {code:r}
ERR={"400":{"$ref":"#/components/responses/Problem"},"401":{"$ref":"#/components/responses/Problem"},"403":{"$ref":"#/components/responses/Problem"},"404":{"$ref":"#/components/responses/Problem"},"409":{"$ref":"#/components/responses/Problem"},"429":{"$ref":"#/components/responses/Problem"}}
def op(tag,summary,resp,req=None,sec=True,params=None,idem=False,roles=None,desc=None):
    o={"tags":[tag],"summary":summary,"responses":{**resp,**ERR}}
    if desc: o["description"]=desc
    if roles: o["x-roles"]=roles; o["description"]=(desc+"\n\n" if desc else "")+"Roles: "+", ".join(roles)
    if req: o["requestBody"]=body(req)
    ps=list(params or [])
    if idem: ps.append({"$ref":"#/components/parameters/IdempotencyKey"})
    if ps: o["parameters"]=ps
    o["security"]=SEC if sec else []
    return o
def path(n,t="string",fmt="uuid"): return {"name":n,"in":"path","required":True,"schema":{"type":t,"format":fmt}}
def q(n,schema=None,desc=None): 
    d={"name":n,"in":"query","schema":schema or {"type":"string"}}
    if desc: d["description"]=desc
    return d
PAGE=[q("limit",{"type":"integer","minimum":1,"maximum":100,"default":20}),q("cursor",desc="Opaque keyset cursor from the previous page's nextCursor")]
ID=[path("id")]
S=lambda n:ref(n)
paths={
"/healthz":{"get":{"tags":["Ops"],"summary":"Liveness","responses":ok("alive")}},
"/readyz":{"get":{"tags":["Ops"],"summary":"Readiness (database reachable)","responses":{**ok("ready"),"503":{"description":"not ready"}}}},
"/v1/auth/register":{"post":op("Auth","Register a patient or doctor",ok("Created",S("RegisterResult"),"201"),"RegisterRequest",sec=False,desc="Doctors start PENDING and cannot publish availability until an admin verifies them. Admins cannot self-register.")},
"/v1/auth/login":{"post":op("Auth","Password login",ok("Tokens, or an MFA challenge",S("LoginResult")),"LoginRequest",sec=False,desc="Doctors/admins/auditors must complete TOTP MFA. Constant-time, generic errors; account lockout after repeated failures.")},
"/v1/auth/mfa/verify":{"post":op("Auth","Complete MFA login",ok("Tokens",S("LoginResult")),"MfaVerifyRequest",sec=False)},
"/v1/auth/refresh":{"post":op("Auth","Rotate refresh token",ok("New token pair",S("TokenPair")),"RefreshRequest",sec=False,desc="Single-use rotation. Re-presenting a used token revokes the whole session family.")},
"/v1/auth/logout":{"post":op("Auth","Revoke current session",{"204":{"description":"Logged out"}})},
"/v1/auth/mfa/enroll":{"post":op("Auth","Begin TOTP enrolment",ok("Secret and otpauth URL",S("MfaEnrollment")))},
"/v1/auth/mfa/activate":{"post":op("Auth","Confirm TOTP enrolment",ok("Recovery codes and an MFA-verified session",S("MfaActivated")),"MfaActivateRequest")},
"/v1/auth/password":{"post":op("Auth","Change password (revokes all sessions)",{"204":{"description":"Changed"}},"PasswordChangeRequest")},
"/v1/me":{"get":op("Users","Current user and profile",ok("Profile",S("Me"))),"patch":op("Users","Update profile",ok("Profile",S("Me")),"ProfileUpdate")},
"/v1/doctors":{"get":op("Doctors","Search doctors",ok("Page of doctors",S("DoctorPage")),sec=False,params=[q("q",desc="Name/specialty/bio prefix search with typo tolerance"),q("specialty"),q("language"),q("city"),q("minRating",{"type":"number"}),q("minFeeMinor",{"type":"integer"}),q("maxFeeMinor",{"type":"integer"}),q("minExperience",{"type":"integer"}),q("availableFrom",{"type":"string","format":"date-time"}),q("availableTo",{"type":"string","format":"date-time"}),q("sort",{"type":"string","enum":["relevance","rating","fee_asc","fee_desc","experience"]})]+PAGE,desc="Public, cached, keyset-paginated. Only VERIFIED doctors are returned.")},
"/v1/doctors/me":{"get":op("Doctors","My doctor profile",ok("Profile",S("DoctorSelf")),roles=["doctor"]),"patch":op("Doctors","Update my doctor profile",ok("Profile",S("DoctorSelf")),"DoctorUpdate",roles=["doctor"])},
"/v1/doctors/me/availability":{"post":op("Availability","Publish availability windows (split into slots)",ok("Result",S("AvailabilityResult"),"201"),"AvailabilityRequest",roles=["doctor"],desc="Re-runnable: overlapping/duplicate slots are skipped (database exclusion constraint).")},
"/v1/doctors/me/slots":{"get":op("Availability","List my slots",ok("Slots",S("OwnSlots")),params=[q("from",{"type":"string","format":"date-time"}),q("to",{"type":"string","format":"date-time"})],roles=["doctor"])},
"/v1/doctors/me/slots/{slotId}":{"delete":op("Availability","Withdraw an open slot",{"204":{"description":"Cancelled"}},params=[path("slotId")],roles=["doctor"])},
"/v1/doctors/{id}":{"get":op("Doctors","Public doctor profile",ok("Doctor",S("Doctor")),sec=False,params=ID)},
"/v1/doctors/{id}/slots":{"get":op("Availability","Open bookable slots",ok("Slots",S("SlotList")),sec=False,params=ID+[q("from",{"type":"string","format":"date-time"}),q("to",{"type":"string","format":"date-time"})])},
"/v1/consultations":{
 "post":op("Consultations","Book a consultation (saga start)",ok("Booked; PENDING_PAYMENT unless the fee is 0",S("Consultation"),"201"),"BookRequest",idem=True,roles=["patient"],desc="**Idempotency-Key required.** Atomically holds the slot, creates the consultation and payment, and enqueues PSP intent creation. The patient has BOOKING_HOLD_SECONDS to pay; the PSP then calls the payment webhook."),
 "get":op("Consultations","List my consultations",ok("Page",S("ConsultationPage")),params=[q("status",{"type":"string","enum":["PENDING_PAYMENT","CONFIRMED","IN_PROGRESS","COMPLETED","CANCELLED","NO_SHOW"]}),q("from",{"type":"string","format":"date-time"}),q("to",{"type":"string","format":"date-time"})]+PAGE,roles=["patient","doctor"])},
"/v1/consultations/{id}":{"get":op("Consultations","Consultation detail (PHI read is audited)",ok("Consultation",S("Consultation")),params=ID,roles=["patient","doctor"])},
"/v1/consultations/{id}/cancel":{"post":op("Consultations","Cancel (idempotent; refund per policy)",ok("Consultation",S("Consultation")),"CancelRequest",params=ID,roles=["patient","doctor"])},
"/v1/consultations/{id}/start":{"post":op("Consultations","Start (from 10 min before scheduled time)",ok("Consultation",S("Consultation")),params=ID,roles=["doctor"])},
"/v1/consultations/{id}/complete":{"post":op("Consultations","Complete with clinical notes",ok("Consultation",S("Consultation")),"CompleteRequest",params=ID,roles=["doctor"])},
"/v1/consultations/{id}/review":{"post":op("Consultations","Review a completed consultation",ok("Review",S("Review"),"201"),"ReviewRequest",params=ID,roles=["patient"])},
"/v1/consultations/{id}/prescriptions":{
 "post":op("Prescriptions","Issue (or revise) a prescription",ok("Prescription",S("Prescription"),"201"),"PrescriptionRequest",params=ID,idem=True,roles=["doctor"],desc="**Idempotency-Key required.** Immutable and versioned; a revision supersedes the previous version. Content is encrypted at rest and HMAC-signed."),
 "get":op("Prescriptions","Prescriptions of a consultation",ok("Items",S("PrescriptionList")),params=ID,roles=["patient","doctor"])},
"/v1/prescriptions":{"get":op("Prescriptions","My active prescriptions",ok("Page",S("PrescriptionPage")),params=PAGE,roles=["patient"])},
"/v1/prescriptions/{id}":{"get":op("Prescriptions","Prescription detail (audited; includes signatureValid)",ok("Prescription",S("Prescription")),params=ID,roles=["patient","doctor"])},
"/v1/payments/{id}":{"get":op("Payments","My payment (includes clientSecret while payable)",ok("Payment",S("Payment")),params=ID,roles=["patient"])},
"/v1/webhooks/payments":{"post":{"tags":["Payments"],"summary":"PSP webhook","description":"Authenticated by `X-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.rawBody)>` with a 5-minute replay window. Deduplicated by event id; late successes after hold expiry are refunded automatically.","security":[],"parameters":[{"name":"X-Webhook-Signature","in":"header","required":True,"schema":{"type":"string"}}],"requestBody":body("WebhookEvent"),"responses":{**ok("Accepted",{"type":"object","properties":{"received":{"type":"boolean"}}}),"400":{"$ref":"#/components/responses/Problem"},"403":{"$ref":"#/components/responses/Problem"}}}},
"/v1/dev/payments/{id}/simulate":{"post":op("Dev","[dev only] Simulate the PSP webhook",ok("Accepted"),params=ID,desc="Only registered when ENABLE_DEV_ENDPOINTS=true (refused in production).")},
"/v1/admin/doctors":{"get":op("Admin","List doctors for verification",ok("Page",S("AdminDoctorPage")),params=[q("status",{"type":"string","enum":["PENDING","VERIFIED","REJECTED","SUSPENDED"]})]+PAGE,roles=["admin"])},
"/v1/admin/doctors/{id}/verification":{"post":op("Admin","Verify / reject / suspend a doctor",ok("Result"),"VerificationRequest",params=ID,roles=["admin"])},
"/v1/admin/users/{id}/suspend":{"post":op("Admin","Suspend user and revoke sessions",{"204":{"description":"Done"}},params=ID,roles=["admin"])},
"/v1/admin/users/{id}/activate":{"post":op("Admin","Re-activate user",{"204":{"description":"Done"}},params=ID,roles=["admin"])},
"/v1/admin/users/{id}/mfa-reset":{"post":op("Admin","Reset a user's MFA (lost device)",{"204":{"description":"Done"}},params=ID,roles=["admin"])},
"/v1/admin/consultations/{id}/cancel":{"post":op("Admin","Cancel any consultation (no clinical data returned)",ok("Consultation",S("Consultation")),params=ID,roles=["admin"])},
"/v1/admin/analytics/summary":{"get":op("Admin","Daily analytics from the pre-aggregated rollup",ok("Summary",S("AnalyticsSummary")),params=[q("from",{"type":"string","format":"date"}),q("to",{"type":"string","format":"date"}),q("specialty")],roles=["admin","auditor"])},
"/v1/admin/audit-logs":{"get":op("Compliance","Query the audit trail (reading is itself audited)",ok("Page",S("AuditPage")),params=[q("actorId"),q("entityType"),q("entityId"),q("action"),q("outcome",{"type":"string","enum":["SUCCESS","DENIED","FAILURE"]}),q("from",{"type":"string","format":"date-time"}),q("to",{"type":"string","format":"date-time"})]+PAGE,roles=["admin","auditor"])},
"/v1/admin/audit-logs/verify":{"post":op("Compliance","Verify audit integrity (row HMACs + checkpoint chain)",ok("Report",S("AuditVerifyReport")),"AuditVerifyRequest",roles=["admin","auditor"])},
"/v1/admin/jobs/dead":{"get":op("Admin","Dead-lettered background jobs",ok("Jobs"),roles=["admin"])},
"/v1/admin/jobs/{id}/requeue":{"post":op("Admin","Requeue a dead job",{"204":{"description":"Requeued"}},params=ID,roles=["admin"])},
}
o=lambda props,req=None:{"type":"object","properties":props,**({"required":req} if req else {})}
s_,i_,b_,dt={"type":"string"},{"type":"integer"},{"type":"boolean"},{"type":"string","format":"date-time"}
uid={"type":"string","format":"uuid"}
money=o({"amountMinor":i_,"currency":s_})
arr=lambda x:{"type":"array","items":x}
page=lambda item:o({"items":arr(S(item)),"nextCursor":s_})
sch={
"Problem":o({"type":s_,"title":s_,"status":i_,"code":s_,"detail":s_,"requestId":s_,"errors":arr(o({"path":s_,"message":s_}))},["status","code"]),
"RegisterRequest":o({"email":{"type":"string","format":"email"},"password":{"type":"string","minLength":12,"maxLength":128},"fullName":s_,"phone":s_,"role":{"type":"string","enum":["patient","doctor"]},"doctor":o({"licenseNumber":s_,"specialties":arr(s_),"languages":arr(s_),"city":s_,"bio":s_,"yearsExperience":i_,"consultationFeeMinor":i_},["licenseNumber","specialties","consultationFeeMinor"])},["email","password","fullName"]),
"RegisterResult":o({"id":uid,"role":s_,"status":s_}),
"LoginRequest":o({"email":s_,"password":s_},["email","password"]),
"TokenPair":o({"accessToken":s_,"refreshToken":s_,"tokenType":{"type":"string","enum":["Bearer"]},"expiresIn":i_}),
"LoginResult":{"oneOf":[{"allOf":[S("TokenPair"),o({"mfaRequired":{"type":"boolean","enum":[False]},"mfaEnrollmentRequired":b_,"user":o({"id":uid,"role":s_,"mfaEnabled":b_})})]},o({"mfaRequired":{"type":"boolean","enum":[True]},"mfaToken":s_})]},
"MfaVerifyRequest":o({"mfaToken":s_,"code":{"type":"string","pattern":"^\\d{6}$"},"recoveryCode":s_},["mfaToken"]),
"RefreshRequest":o({"refreshToken":s_},["refreshToken"]),
"MfaEnrollment":o({"secret":s_,"otpauthUrl":s_}),
"MfaActivateRequest":o({"code":{"type":"string","pattern":"^\\d{6}$"}},["code"]),
"MfaActivated":{"allOf":[S("TokenPair"),o({"recoveryCodes":arr(s_)})]},
"PasswordChangeRequest":o({"currentPassword":s_,"newPassword":s_},["currentPassword","newPassword"]),
"Me":o({"id":uid,"role":s_,"mfaEnabled":b_,"email":s_,"profile":o({"fullName":s_,"phone":s_,"dateOfBirth":s_,"gender":s_,"locale":s_,"timezone":s_})}),
"ProfileUpdate":o({"fullName":s_,"phone":s_,"dateOfBirth":s_,"gender":s_,"locale":s_,"timezone":s_}),
"Doctor":o({"id":uid,"displayName":s_,"bio":s_,"specialties":arr(s_),"languages":arr(s_),"city":s_,"yearsExperience":i_,"consultationFee":money,"rating":o({"average":{"type":"number"},"count":i_}),"nextAvailableAt":dt}),
"DoctorSelf":{"allOf":[S("Doctor"),o({"licenseNumber":s_,"verificationStatus":s_})]},
"DoctorPage":page("Doctor"),
"DoctorUpdate":o({"displayName":s_,"bio":s_,"specialties":arr(s_),"languages":arr(s_),"city":s_,"yearsExperience":i_,"consultationFeeMinor":i_}),
"AvailabilityRequest":o({"windows":arr(o({"start":dt,"end":dt},["start","end"])),"slotMinutes":{"type":"integer","enum":[10,15,20,30,45,60]}},["windows","slotMinutes"]),
"AvailabilityResult":o({"requested":i_,"created":i_,"skippedOverlapping":i_}),
"OwnSlots":o({"slots":arr(o({"id":uid,"startAt":dt,"endAt":dt,"status":{"type":"string","enum":["OPEN","HELD","BOOKED"]}}))}),
"SlotList":o({"doctorId":uid,"slots":arr(o({"id":uid,"startAt":dt,"endAt":dt}))}),
"BookRequest":o({"slotId":uid,"reason":{"type":"string","maxLength":1000}},["slotId"]),
"Consultation":o({"id":uid,"status":{"type":"string","enum":["PENDING_PAYMENT","CONFIRMED","IN_PROGRESS","COMPLETED","CANCELLED","NO_SHOW"]},"doctorId":uid,"patientId":uid,"specialty":s_,"scheduledAt":dt,"endsAt":dt,"fee":money,"reason":s_,"notes":s_,"cancellation":o({"reason":s_,"at":dt,"by":s_}),"startedAt":dt,"completedAt":dt,"createdAt":dt,"payment":o({"id":uid,"status":s_,"expiresAt":dt})}),
"ConsultationPage":page("Consultation"),
"CancelRequest":o({"reason":s_}),
"CompleteRequest":o({"notes":{"type":"string","maxLength":10000}}),
"ReviewRequest":o({"rating":{"type":"integer","minimum":1,"maximum":5},"comment":s_},["rating"]),
"Review":o({"consultationId":uid,"rating":i_}),
"PrescriptionRequest":o({"diagnosis":s_,"medications":arr(o({"name":s_,"dosage":s_,"frequency":s_,"durationDays":i_,"instructions":s_},["name","dosage","frequency","durationDays"])),"advice":s_},["diagnosis","medications"]),
"Prescription":o({"id":uid,"consultationId":uid,"version":i_,"status":{"type":"string","enum":["ACTIVE","SUPERSEDED"]},"signature":s_,"signatureValid":b_,"diagnosis":s_,"medications":arr({"type":"object"}),"advice":s_,"issuedAt":dt}),
"PrescriptionList":o({"items":arr(S("Prescription"))}),
"PrescriptionPage":page("Prescription"),
"Payment":o({"id":uid,"consultationId":uid,"status":{"type":"string","enum":["PENDING","REQUIRES_PAYMENT","SUCCEEDED","FAILED","VOIDED","REFUND_PENDING","REFUNDED"]},"amount":money,"refundAmountMinor":i_,"clientSecret":s_,"expiresAt":dt}),
"WebhookEvent":o({"id":s_,"type":{"type":"string","enum":["payment.succeeded","payment.failed"]},"data":o({"paymentId":uid,"providerRef":s_,"failureCode":s_},["paymentId"])},["id","type","data"]),
"VerificationRequest":o({"decision":{"type":"string","enum":["VERIFIED","REJECTED","SUSPENDED"]},"note":s_},["decision"]),
"AdminDoctorPage":page("DoctorSelf"),
"AnalyticsSummary":o({"range":o({"from":s_,"to":s_}),"totals":o({"scheduled":i_,"confirmed":i_,"completed":i_,"cancelled":i_,"noShows":i_,"revenueMinor":i_,"refundsMinor":i_,"netRevenueMinor":i_,"completionRate":{"type":"number"},"cancellationRate":{"type":"number"}}),"daily":arr({"type":"object"}),"bySpecialty":arr({"type":"object"})}),
"AuditEntry":o({"id":i_,"created_at":dt,"actor_id":uid,"actor_role":s_,"action":s_,"entity_type":s_,"entity_id":s_,"outcome":s_,"request_id":s_,"trace_id":s_,"ip":s_,"metadata":{"type":"object"}}),
"AuditPage":page("AuditEntry"),
"AuditVerifyRequest":o({"from":dt,"to":dt},["from","to"]),
"AuditVerifyReport":o({"ok":b_,"rowsChecked":i_,"badSignatures":arr(i_),"checkpointsChecked":i_,"badCheckpoints":arr(i_)}),
}
doc={"openapi":"3.0.3","info":{"title":"Amrutam Telemedicine API","version":"1.0.0","description":"Auth/MFA/RBAC, doctor availability & booking (saga), consultations, prescriptions, search, audit and admin analytics.\n\nConventions: errors are RFC 7807 `application/problem+json`; writes that create resources require `Idempotency-Key`; lists use opaque keyset cursors; times are ISO-8601 UTC. SLOs: reads p95 < 200 ms, writes p95 < 500 ms."},
"servers":[{"url":"https://api.amrutam.example"},{"url":"http://localhost:3000"}],
"tags":[{"name":n} for n in ["Auth","Users","Doctors","Availability","Consultations","Prescriptions","Payments","Compliance","Admin","Ops","Dev"]],
"paths":paths,
"components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer","bearerFormat":"JWT (ES256)"}},
"parameters":{"IdempotencyKey":{"name":"Idempotency-Key","in":"header","required":True,"schema":{"type":"string","minLength":8,"maxLength":128,"pattern":"^[A-Za-z0-9_\\-:.]+$"},"description":"Client-generated unique key (UUID recommended). Retrying with the same key and payload returns the original response (`Idempotent-Replayed: true`); same key with a different payload returns 422."}},
"responses":{"Problem":{"description":"Error (RFC 7807)","content":{"application/problem+json":{"schema":S("Problem")}}}},
"schemas":sch}}
open('docs/openapi.yaml','w').write("# GENERATED by scripts/build-openapi.py - edit that file, not this one.\n"+yaml.dump(doc,Dumper=type('D',(yaml.SafeDumper,),{'ignore_aliases':lambda self,d:True}),sort_keys=False,width=140))
print(len(paths),'paths',sum(len(v) for v in paths.values()),'operations')
