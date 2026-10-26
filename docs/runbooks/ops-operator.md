# Ops operator

This runbook describes how the human owner grants platform roles to an operator, revokes operator access, and recovers an operator who has lost passkeys.

## Purpose and safety

The human owner alone runs this tool. An agent does not. This command runs as a one-off override of the service task definition (`/app/ops-operator.js`), not the `db_ops` task definition; it adds no HTTP route and requires no change to IAM roles.

The operator administration tool shares the one fixed secret name (`${PROVISION_SECRET_NAME}`) with `provision-owner` (`apply-staging-au.md`). The two tools refuse each other's payloads before querying the database, but concurrent runs would overwrite or race on the one shared secret name. Therefore:

- **Never run `ops-operator` and `provision-owner` at the same time.** Only one run of either tool happens at a time.
- **Delete and verify runs after every execution.** The secret exists only between **Create** and **Delete and verify**; it is destroyed with `--force-delete-without-recovery` immediately after every run, on success, on any failure word, and even when the task never started.
- **Shell variables and placeholders only.** Never paste an account id, an ARN, a hostname, the resolved secret name, an email address, an enrolment code, or an IP address into this runbook or into evidence. In zsh write `${VAR}:text`, not `$VAR:text`.
- **Evidence is counts, statuses, lengths and the one-off's fixed result words only.** Never an ARN, secret name, hostname, address or code. The enrolment code and email address are confidential. The enrolment code is generated offline on the owner's machine, displayed once, and delivered out of band to the operator. It is never committed, logged, or pasted into evidence.

## Prerequisites

- The service image containing `/app/ops-operator.js` is deployed, and the service task definition points to that image.
- A working database with product and identity migrations applied.
- CLI tools available on the owner's workstation:
  - `aws` (AWS CLI v2)
  - `jq`
  - `python3` (on macOS available via the Command Line Tools, e.g. `xcode-select --install`)
- The shell variables the `provision-owner` section of `apply-staging-au.md` uses are set in the active terminal session:
  - `${AWS_PROFILE}`: AWS CLI profile with owner permissions in `ap-southeast-2`
  - `${CLUSTER}`: ECS cluster name
  - `${SERVICE_TASK_DEFINITION}`: Service task definition family/revision
  - `${SUBNET}`: Staging public subnet ID
  - `${TASK_SECURITY_GROUP}`: Security group allowing egress to RDS, KMS, Secrets Manager, and CloudWatch Logs
  - `${LOG_GROUP}`: Service log group name
  - `${PROVISION_SECRET_NAME}`: The one fixed secret name (`${name}-provision-owner`)
  - `${SECRETS_KEY_ARN}`: KMS customer-managed key ARN for Secrets Manager encryption
- Only one run happens at a time. Confirm no other run of `ops-operator` or `provision-owner` is in progress.

## Check the name is free

Confirm that the one fixed secret name does not already exist. The `describe-secret` call redirected through `grep` must succeed (exit 0) and print nothing:

    aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} 2>&1 >/dev/null | grep -q ResourceNotFoundException

If this check fails (exits non-zero or prints anything):

- If the secret exists, stop immediately: another run is in progress or a previous run was not cleaned up. Investigate and do not proceed.
- If the error is anything else (such as invalid AWS credentials, wrong profile, or region mismatch), stop and fix the underlying issue before proceeding.

## Generate the enrolment code

This step applies to **grant** and **recover** only. For **revoke**, skip this step.

Generate a 160-bit (32 character) unpadded Base32 enrolment code offline on the owner's machine:

    ENROLMENT_CODE=$(python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode())')

    print -r -- "${ENROLMENT_CODE}"

The `print` command displays the code once. The owner hands the enrolment code to the operator through a private channel other than email — encrypted messaging, a password manager share, or in person — because email already carries the other factor (the `operator_enrolment` email code) and a single mailbox compromise would yield both.

Immediately after copying the code, clear the screen and terminal scrollback in the same terminal tab:

- In macOS Terminal.app and iTerm2: press **Cmd-K** (Clear Scrollback).
- Alternatively: run `printf '\033c'` and use the terminal's clear-scrollback menu command.

Clearing the scrollback in the same tab preserves `${ENROLMENT_CODE}` in the shell session for **Create** while ensuring the secret code does not remain visible on screen or in scrollback history. The code goes to the operator out of band only and is never typed as a command-line argument, written to a file, or pasted into pull requests or evidence.

## Create

Prompt for inputs using `read -rs` followed by `print`, so values are never typed as command-line arguments or saved in shell command history. Assemble the JSON payload with `jq -n` and pipe directly into `create-secret`. The create output is discarded (`>/dev/null`).

`create-secret` must specify `--kms-key-id ${SECRETS_KEY_ARN}` so the secret is encrypted under the customer-managed key; without it, encryption defaults to the account AWS-managed key and the task role cannot read it.

Type the prompt and commands directly into one terminal; do not click an editor's "Run" button while a prompt is waiting.

A failed `create-secret` is **stop**, not retry; always unset the variables immediately. Always end with `unset OPERATOR_EMAIL ROLE_KEYS ENROLMENT_CODE`.

### Grant

    read -rs "OPERATOR_EMAIL?Operator email: "

    print

    read -rs "ROLE_KEYS?Platform role keys (comma-separated, e.g. platform_admin,platform_support): "

    print

    jq -n --arg a grant --arg e "${OPERATOR_EMAIL}" --arg r "${ROLE_KEYS}" --arg c "${ENROLMENT_CODE}" \
      '{opsOperator: {action: $a, email: $e, roleKeys: ($r | gsub("\\s"; "") | split(",")), enrolmentCode: $c}}' \
      | aws secretsmanager create-secret --profile ${AWS_PROFILE} \
        --name ${PROVISION_SECRET_NAME} --kms-key-id ${SECRETS_KEY_ARN} \
        --secret-string file:///dev/stdin >/dev/null

    unset OPERATOR_EMAIL ROLE_KEYS ENROLMENT_CODE

### Recover

    read -rs "OPERATOR_EMAIL?Operator email: "

    print

    read -rs "ROLE_KEYS?Platform role keys (comma-separated, e.g. platform_admin,platform_support): "

    print

    jq -n --arg a recover --arg e "${OPERATOR_EMAIL}" --arg r "${ROLE_KEYS}" --arg c "${ENROLMENT_CODE}" \
      '{opsOperator: {action: $a, email: $e, roleKeys: ($r | gsub("\\s"; "") | split(",")), enrolmentCode: $c}}' \
      | aws secretsmanager create-secret --profile ${AWS_PROFILE} \
        --name ${PROVISION_SECRET_NAME} --kms-key-id ${SECRETS_KEY_ARN} \
        --secret-string file:///dev/stdin >/dev/null

    unset OPERATOR_EMAIL ROLE_KEYS ENROLMENT_CODE

### Revoke

    read -rs "OPERATOR_EMAIL?Operator email: "

    print

    jq -n --arg e "${OPERATOR_EMAIL}" \
      '{opsOperator: {action: "revoke", email: $e}}' \
      | aws secretsmanager create-secret --profile ${AWS_PROFILE} \
        --name ${PROVISION_SECRET_NAME} --kms-key-id ${SECRETS_KEY_ARN} \
        --secret-string file:///dev/stdin >/dev/null

    unset OPERATOR_EMAIL ROLE_KEYS ENROLMENT_CODE

## Run

Hold `${PROVISION_SECRET_ARN}` from a read-only describe of the secret. It is never recorded in evidence.

    PROVISION_SECRET_ARN=$(aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} --query 'ARN' --output text)

Run the service task definition as a one-off with container overrides setting `command` to `["node","/app/ops-operator.js"]` and `PROVISION_SECRET_ARN` to the held ARN. Use the task security group, staging public subnet, and public address assignment:

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides "{\"containerOverrides\":[{\"name\":\"service\",\"command\":[\"node\",\"/app/ops-operator.js\"],\"environment\":[{\"name\":\"PROVISION_SECRET_ARN\",\"value\":\"${PROVISION_SECRET_ARN}\"}]}]}" \
      --query 'tasks[0].taskArn' --output text)

Wait for the task to stop, describe the exit code and stopped reason, and retrieve the log events from the single log stream (`service/service/${TASK_ARN##*/}`):

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} \
      --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} \
      --log-stream-name "service/service/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

The describe step prints the container exit code and stopped reason separated by a tab. The task writes only the one line shown in **Results** below. It never writes an email address, enrolment code, user ID, role key, SQL statement, or database driver error. Read the stopped reason; do not paste it into evidence when it can name a registry or secret.

## Results

**Create** always runs before **Run**, so by the time any outcome below is read the secret already exists — on success, on any failure word, and even when the task never started. Every row therefore ends at **Delete and verify**.

| Exit | Stdout        | Stderr               | Meaning and what to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `granted`     | empty                | The operator was granted the requested platform role(s). If the user did not exist in `identity.users`, they were created. An open grant was recorded with a 24-hour enrolment window. The operator enrols on the ops host within 24 hours with an email code and the enrolment code, registers two passkeys, then signs in. Go to **Delete and verify**.                                                                                                                                                                                                                                                |
| 0    | `revoked`     | empty                | All grants, operator sessions, and enrolment sessions for the user were revoked, and their ops passkeys were deleted. Tenant access is untouched. `revoked` does not prove a grant existed: revoking an existing user who held no operator grant succeeds cleanly. The operator does nothing further. Go to **Delete and verify**.                                                                                                                                                                                                                                                                       |
| 0    | `recovered`   | empty                | In one transaction, all existing grants and sessions were revoked, existing ops passkeys deleted, a `recovery_regrant` event recorded in `identity.operator_events`, and a fresh grant created with the new enrolment code and a fresh 24-hour window. `recover` for a user with no earlier grant acts as a grant plus `recovery_regrant`. The operator enrols on the ops host within 24 hours with an email code and the new enrolment code, registers two new passkeys, then signs in. Go to **Delete and verify**.                                                                                    |
| 1    | empty         | `env`                | `PROVISION_SECRET_ARN` is missing, malformed, or does not match the `-provision-owner-` pattern, or the service environment (`OPS_HOSTNAME`, CA bundle) could not be read. The secret was not read and nothing was changed. Check the task definition and environment override. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                             |
| 1    | empty         | `secret`             | The secret could not be read from Secrets Manager, or its contents are not valid JSON, or parsed to `null`, an array, or another non-object. Nothing was changed. Check KMS key permissions, recreate the secret via **Create**, and run again. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                             |
| 1    | empty         | `shape`              | The secret payload structure is invalid: the top level does not contain exactly `opsOperator`, an unknown key was present, `action` was not one of `grant`, `revoke`, `recover`, `email` was empty, `roleKeys` or `enrolmentCode` were missing for `grant`/`recover`, or extraneous keys were present for `revoke`. Also triggered if a `provision-owner` payload is sent. Recreate the secret via **Create** and run again. Go to **Delete and verify**.                                                                                                                                                |
| 1    | empty         | `refused`            | Pre-check or identity validation refused the request: an invalid role key (must be one or more of `platform_admin`, `platform_support`, `platform_security`, without duplicates), an enrolment code not matching `^[A-Za-z2-7]{26,128}$` (after stripping spaces and hyphens), a malformed email address (triggering `invalid_email`), or a conflicting grant (an open or active grant for the user). A `grant` refused after creating a user leaves that user, and re-running the same `grant` reuses it. Check inputs, fix the cause, recreate the secret, and run again. Go to **Delete and verify**. |
| 1    | empty         | `user`               | `revoke` or `recover` was called for an email address that has no user in `identity.users`. Unlike `grant`, `revoke` and `recover` never create a user. Verify the email address. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                                                                                           |
| 1    | empty         | `kms`                | The KMS envelope encryption call (`GenerateDataKey` or `Decrypt`) failed during user encryption or blind indexing. Check the envelope-key grant and status in `ap-southeast-2`, then run again. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                                                                             |
| 1    | empty         | `connect`            | The database connection failed with no database error (a network, DNS, or TLS problem). Check the task security group and subnet. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1    | empty         | `connect <SQLSTATE>` | The database connection or query failed with that database error code (`connect <SQLSTATE>` is any database error with that code). Nothing was changed. Check database health and credentials, fix the cause, and run again. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                                                |
| 1    | empty         | `fail`               | Anything else. The word `fail` is the only evidence; there is no error message or stack trace. If a `grant` created a user before failing, re-running the same `grant` reuses that user. Check task and service logs, fix the cause, and run again. Go to **Delete and verify**.                                                                                                                                                                                                                                                                                                                         |
| none | no log stream | none                 | The task never started. The exit code prints `None` and the stopped reason names the cause (an image pull or a secret injection failure). No command ran and nothing was changed. Fix the cause the reason names, then run again. Go to **Delete and verify**. The stopped reason can name a registry or a secret, so do not copy it into the evidence.                                                                                                                                                                                                                                                  |

## Delete and verify

Delete the secret immediately after the run, without recovery, so the one fixed name is freed for the next run. Then confirm that the secret is gone:

    aws secretsmanager delete-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} --force-delete-without-recovery

    aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} 2>&1 >/dev/null | grep -q ResourceNotFoundException

    unset PROVISION_SECRET_ARN

The `describe-secret` call redirected through `grep` must succeed (exit 0) and print nothing, confirming that the secret was completely destroyed. If it exits non-zero or prints any error, stop and investigate. Unset `${PROVISION_SECRET_ARN}`.

## Grant an operator, Revoke an operator, Recover an operator

Each procedure below is an ordered sequence referencing the sections above.

### Grant an operator

1. Ensure **Prerequisites** are met and run **Check the name is free**.
2. Run **Generate the enrolment code** to generate and display `${ENROLMENT_CODE}` once, deliver it to the operator through an out-of-band channel, and clear terminal scrollback (Cmd-K).
3. Run **Create** using the **Grant** variant, entering the operator email and comma-separated role keys (`platform_admin`, `platform_support`, `platform_security`).
4. Execute the one-off via **Run**.
5. Check **Results** — expect exit 0 and stdout `granted`.
6. Run **Delete and verify**.
7. **What the operator does next**: The operator enrols on the ops host within 24 hours with an email verification code and the enrolment code, registers two passkeys, then signs in to the ops console.

### Revoke an operator

1. Ensure **Prerequisites** are met and run **Check the name is free**.
2. Run **Create** using the **Revoke** variant, entering the operator email. (Step **Generate the enrolment code** is omitted.)
3. Execute the one-off via **Run**.
4. Check **Results** — expect exit 0 and stdout `revoked`.
5. Run **Delete and verify**.
6. **What the operator does next**: Nothing. All grants, operator sessions, and enrolment sessions are revoked, and ops passkeys are deleted. The operator can no longer access the ops console. Tenant access, if any, is untouched.

### Recover an operator

Under ADR 0015 (interim single-owner recovery), the owner alone recovers an operator who has lost passkeys. In a single transaction, the one-off revokes every existing grant and session of the operator, deletes their old ops passkeys (so a lost or stolen device cannot sign in), records a `recovery_regrant` event in `identity.operator_events` alongside the revocation and grant events, and issues a fresh grant with a new enrolment code and a fresh 24-hour window. If run for an operator with no prior grant, `recover` acts as a grant plus `recovery_regrant`.

This single-owner recovery procedure is an interim risk accepted under ADR 0015, scheduled for review by 2027-04-30 or when a second `platform_security` person joins, whichever is first.

1. Ensure **Prerequisites** are met and run **Check the name is free**.
2. Run **Generate the enrolment code** to generate and display a new `${ENROLMENT_CODE}` once, deliver it to the operator through an out-of-band channel, and clear terminal scrollback (Cmd-K).
3. Run **Create** using the **Recover** variant, entering the operator email and comma-separated role keys (`platform_admin`, `platform_support`, `platform_security`).
4. Execute the one-off via **Run**.
5. Check **Results** — expect exit 0 and stdout `recovered`.
6. Run **Delete and verify**.
7. **What the operator does next**: The operator enrols on the ops host within 24 hours with an email verification code and the new enrolment code, registers two new passkeys, then signs in. The old passkeys are deleted and cannot be used.
