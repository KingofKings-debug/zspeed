# Docker and cloud deployment

All four application components run together: the backend and simulator each have a container, and both built UIs share a Caddy web container. Docker waits for the simulator and backend to become healthy before serving the UIs. API calls, Socket.IO and simulator controls use the same web address. Only web ports 80 and 443 are public.

## One command on Windows

Install Docker Desktop, select Linux containers, and start it. Then double-click **Start-ZSpeed.cmd**, or in the project folder run:

```powershell
.\start.ps1
```

Open **http://localhost** for the fleet app and **http://localhost/simulator/** for the simulator console. The script prints your generated login. Both use the username and password saved in `docker/credentials.txt`. The simulator console uses the browser's login prompt. The fleet app uses its existing login form.

On any Linux cloud VM with Docker Engine and Compose v2 installed:

```sh
sh start.sh
```

Open the server's public IP. Allow inbound TCP ports 80 and 443 in its firewall. Ports 3001 and 3002 stay inside Docker; there is no need to run the four development terminals.

For HTTPS, point a domain's DNS A record at the server, then use `./start.ps1 -Domain fleet.example.com` on the first Windows start or `SITE_ADDRESS=fleet.example.com sh start.sh` on Linux. Caddy obtains and renews HTTPS certificates. For an existing installation, change `SITE_ADDRESS` in `docker/.env` and recreate the web container. Use HTTPS before logging in over the public Internet.

## One command to create an AWS deployment

Install AWS CLI v2 and configure an account with permission to manage CloudFormation, EC2, IAM roles and S3. Then run:

```powershell
.\deploy-aws.ps1
```

This uploads **the current folder's source**, including local code fixes, to a private encrypted S3 bucket and creates an Amazon Linux EC2 instance in the default public subnet in Mumbai (`ap-south-1`). The template builds and starts the containers and reports the fleet and simulator URLs after startup succeeds. You do not need to push to GitHub first.

This command creates **billable** resources: a `t3.medium` instance, a 30 GB encrypted EBS disk, public IPv4 and deployment objects in S3. No AWS resources are created merely by editing this project or running the local start command.

Optional settings:

```powershell
.\deploy-aws.ps1 -Region us-east-1 -StackName my-fleet -SubnetId subnet-0123456789abcdef0
```

The subnet must have an Internet Gateway route. No SSH port is opened. To retrieve your login, open the instance through **AWS Systems Manager → Session Manager** and run:

```sh
sudo cat /opt/zspeed/docker/credentials.txt
```

To enable a domain after launch, point DNS at the reported instance IP, edit `/opt/zspeed/docker/.env` so `SITE_ADDRESS='fleet.example.com'`, and run:

```sh
cd /opt/zspeed
sudo docker compose --env-file docker/.env up -d --force-recreate web
```

If you supply `-Domain` during launch, DNS must point at the new instance before HTTPS becomes available. The initial public IP can change after stopping/starting EC2; assign an Elastic IP for a stable production address.

## Persistence, updates and troubleshooting

The first Docker start creates a separate production configuration with demo access disabled, a real login, and random authentication/encryption keys. It does not use or overwrite your development `.env`. Keep `docker/.env` safe and back it up with your data; replacing its encryption key prevents reading previously encrypted connection credentials. Subsequent starts retain existing settings.

SQLite databases live in the `zspeed_backend-data` and `zspeed_simulator-data` Docker volumes. Restarts and image rebuilds preserve them. Existing Windows development databases are **not** automatically uploaded or copied. This is a single-server deployment; multiple backend replicas require a separate database architecture change.

```sh
# Status and logs
docker compose --env-file docker/.env ps
docker compose --env-file docker/.env logs --tail=100 backend simulator web
# Stop while retaining data
docker compose --env-file docker/.env down
# Rebuild after copying updated source onto the SAME server
sh start.sh
```

Do not add `-v` to `down` unless you intend to delete the databases and certificates. Back up both database volumes and `docker/.env` before updates. The AWS launch script is for provisioning; running it again can replace the EC2 instance because its source archive changes. Update an existing server in place instead.

For AWS startup failures, inspect CloudFormation stack events and `/var/log/zspeed-startup.log` through Session Manager. For local API failures, the logs above show which service failed to become ready.

To stop AWS charges, delete the CloudFormation stack. The database disk is deliberately retained (`DeleteOnTermination: false`); recover/back up needed data, then delete that detached EBS volume and the deployment bucket/objects yourself. These retained resources continue to incur storage charges.

References: [Caddy routing and HTTPS patterns](https://caddyserver.com/docs/caddyfile/patterns), [AWS application deployment with CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/deploying.applications.html).

## Read snapshots, replica, cache and background jobs

The backend starts and supervises a separate worker process automatically; there is no extra manual startup step. The durable queue lives in the operational database. Changes enqueue refresh requests in the same transaction, and repeated requests for a vehicle or trip are combined. Existing events remain unchanged. Historical recovery persists individual outcomes and yields after 25 events, so it resumes after a worker restart.

Docker adds an internal Redis service with a 128 MB memory limit and five-second cached snapshot expiry. Redis has no exposed host port and is disposable; an unavailable cache falls back to the read replica. The API bounds cache waits to 80 milliseconds and temporarily bypasses an unresponsive cache. Redis failure does not prevent the backend starting.

The backend data volume contains three separate database files: `zspeed.db` (operational), `vehicle-reads.db` (saved vehicle and trip snapshots), and `vehicle-replica.db` (asynchronous read replica). Vehicle detail, trip lists, maps, important trip events and quality reads use the replica. A selected trip loads through one `/api/vehicles/:vehicleId/trips/:tripId/bundle` request. Trip lists are paginated in groups of 50; older trips remain accessible. Fleet overview, connection management, live event catch-up and write APIs continue using their existing paths.

First startup prepares existing vehicles and trips gradually. Vehicle pages retry while their first snapshot is being built. Once available, the previous completed snapshot remains readable while updates are queued. The Backend Jobs tab displays fleet-scoped queue activity, retry counts, recovery progress, worker heartbeat, replication backlog and cache availability. Snapshot timestamps indicate freshness; eventual consistency means a newly received event need not appear immediately. New vehicle summaries have reserved refresh capacity, and continuously arriving changes cannot indefinitely postpone a refresh.

Optional development settings in the root `.env`:

```dotenv
# Redis is optional locally; Docker supplies its own internal URL.
REDIS_URL=redis://127.0.0.1:6379
READ_MODEL_PATH=./data/vehicle-reads.db
READ_REPLICA_PATH=./data/vehicle-replica.db
MAINTENANCE_TIMEZONE=Asia/Kolkata
MAINTENANCE_START_HOUR=0
MAINTENANCE_END_HOUR=6
```

Paths are relative to the backend working directory. Without overrides the read databases are created beside the operational database. During busy periods the worker reserves capacity for incoming events and slows historical maintenance; quiet hours increase batch capacity. Maintenance waiting longer than ten minutes becomes eligible even under sustained traffic. Each cycle yields between jobs and limits its batch time, but an individual trip rebuild cannot be interrupted halfway through its transaction. Invalid timezone configuration must be corrected if the worker reports repeated scheduling errors.

This is a durable queue architecture, without a Kafka dependency. The replica is a separate database copy of the materialized read data on the same server. It reduces operational query load and isolates saved reads from operational writes; it does **not** provide cross-server failover or remove SQLite's single-writer limit. Run one backend per operational database. Stop the old backend before starting its replacement. Do not put SQLite WAL files on a network filesystem. At a scale requiring multiple writers or host failover, migrate the operational store to a server database and an external broker.

Back up `zspeed.db` using SQLite's backup mechanism together with configuration/secrets. The read model and replica can be regenerated from retained operational data, but preserve both for faster restoration. Do not manually copy a live SQLite database without its WAL or a consistent backup. Worker restarts recover queued work; failures remain visible and retry with backoff.

Design references: [SQLite WAL concurrency](https://sqlite.org/wal.html), [Redis production client behavior](https://redis.io/docs/latest/develop/clients/nodejs/produsage/).

Verification: run `npm test` in `backend` for the regression and read-scaling tests. With Docker running, set `RUN_DOCKER_TESTS=1` and run `npm test -- src/tests/redis-container.test.ts` to verify cache hits, real Redis expiry and fallback after stopping its isolated test container. The normal suite skips this optional container test.

The Background Jobs screen displays logical activities rather than individual event tasks. Vehicle event processing and trip calculations share one stable job ID while new work continues to arrive within five minutes. Recovery and manual rebuilds keep separate IDs. Each activity includes the vehicle, purpose, first start time, latest activity, status, totals and progress. The Data Pipeline screen updates existing results in place, coalesces repeated notifications and preserves visible results if a refresh fails.
