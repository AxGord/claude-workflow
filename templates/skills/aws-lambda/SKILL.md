---
name: aws-lambda
description: AWS Lambda .NET deployment gotchas
---

# AWS Lambda + .NET Gotchas

## VPC Networking

- **ENIs are shared since the Hyperplane rework (2019)** — one ENI per subnet + security-group combo, created when the function is created or its VPC config changes, NOT per concurrent execution. Scale-up does not consume a subnet IP per instance, so subnet IP exhaustion from Lambda scaling is largely a pre-2019 concern.
- **ENI provisioning takes up to ~90s** at function create / VPC-config change; the function reports `LastUpdateStatus: InProgress` until done. (The old per-invoke ENI cold-start penalty is gone.)
- **S3/Secrets Manager calls timeout silently (not connection refused)** when Lambda is in VPC without NAT/VPC Endpoint. Easy to misdiagnose as SDK bug.

## Logging

- **`Console.Error.WriteLine()` IS captured by CloudWatch on the managed .NET runtime** (Lambda redirects the process's stdout/stderr) — but entries lack the request-id prefix and multi-line output splits into separate events. Output genuinely disappears only in narrower cases: writes during a crashed INIT (process torn down before flush) or a custom-runtime bootstrap that doesn't forward stderr. Prefer `ILambdaContext.Logger.LogLine()` in handler code or `ILogger` in the ASP.NET pipeline.
- **Missing `logs:CreateLogGroup` permission = logs silently lost.** Log group created lazily on first invoke. No permission = no log group = nowhere to write = no error visible anywhere.

## ASP.NET Core in Lambda

- **`UseHttpsRedirection()` hangs Lambda.** No Kestrel HTTPS port. Middleware hangs trying to discover one (aws-lambda-dotnet #1543; discussion #1424 reports the same shape — handler completes but the response never reaches the runtime — as warm-invoke middleware timeouts on a custom runtime). Only enable in Development.
- **Response > 6MB fails the invoke — no clean HTTP 413.** 6MB is the synchronous INVOKE-phase request/response payload limit (nothing to do with INIT). `APIGatewayHttpApiV2ProxyFunction` surfaces it as a runtime-client error for that invocation, so the caller sees a generic 500-style failure instead of a 413.

## S3 from Lambda

- **SDK default timeout = infinite, retry = 4 with exponential backoff.** Total wait 30-60s can exceed Lambda timeout. Always set `Timeout` and `MaxErrorRetry` on `AmazonS3Config`.
- **Region fallback to `us-east-1` is a local-dev gotcha, not a Lambda one.** Inside Lambda the SDK resolves the region from the `AWS_REGION` env var the service injects. `new AmazonS3Client()` without explicit region silently targets `us-east-1` only when no env/profile region is configured — e.g. local integration tests — causing slow cross-region requests with no error.
- **IMDS does not exist inside Lambda.** Credentials come from env vars (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`) injected from the execution role. Any "IMDS credential error is cached until restart" advice applies to EC2/ECS, not Lambda.

## .NET Cold Start

- **ReadyToRun (R2R) output is RID-specific — publish with `--runtime linux-x64` (or `linux-arm64`).** Since .NET 6, crossgen2 supports cross-OS compilation, so building ON macOS/Windows is fine as long as the target RID matches the Lambda runtime (dotnet8 runs on Amazon Linux 2023). R2R for the wrong RID silently has no effect.
- **INIT-phase billing was standardized 2025-08: INIT is billed for ALL runtimes and packaging types.** Previously ZIP-deployed managed runtimes got the INIT phase free (container images were always billed). Heavy .NET startup now costs money either way — trim startup work or use SnapStart.
- **EF Core `Database.Migrate()` default command timeout = 30s.** Heavy migrations fail with EF timeout, not Lambda timeout. Set `CommandTimeout` explicitly.

## Function URL

- **CORS headers not returned without `Origin` header in request.** Preflight without Origin returns 200 but no Access-Control-* headers. Browser blocks the actual request. Hard to diagnose — server returns 200.

## IAM & Deployment

- **`UpdateFunctionCode` + `UpdateFunctionConfiguration` cannot run simultaneously.** Gives `ResourceConflictException`. CI/CD must wait for `LastUpdateStatus: Successful` between calls.
- **`State: Active` does NOT mean ready.** `LastUpdateStatus: InProgress` means API calls will fail with `ResourceConflictException`. Must check both fields.
- **Provisioned Concurrency on alias/version doesn't help `$LATEST`.** Must invoke the aliased version to benefit. CLI deploys without explicit alias still get cold starts.
