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
