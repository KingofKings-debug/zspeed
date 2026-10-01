param(
    [string]$Region = 'ap-south-1',
    [string]$StackName = 'zspeed',
    [string]$SubnetId = '',
    [string]$Domain = ''
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'Install AWS CLI v2 and configure your AWS credentials first.' }
if ($StackName -notmatch '^[a-zA-Z][a-zA-Z0-9-]{0,60}$') { throw 'Use a stack name beginning with a letter and containing letters, numbers and hyphens.' }
function Invoke-Aws {
    param([string[]]$Arguments)
    $result = & aws @Arguments --region $Region --no-cli-pager
    if ($LASTEXITCODE -ne 0) { throw "AWS command failed: $($Arguments[0]) $($Arguments[1])" }
    return $result
}
$account = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
if (-not $SubnetId) {
    $SubnetId = Invoke-Aws @('ec2', 'describe-subnets', '--filters', 'Name=default-for-az,Values=true', '--query', 'Subnets[0].SubnetId', '--output', 'text')
    if (-not $SubnetId -or $SubnetId -eq 'None') { throw 'No default public subnet was found. Supply -SubnetId for your public subnet.' }
}
$vpc = Invoke-Aws @('ec2', 'describe-subnets', '--subnet-ids', $SubnetId, '--query', 'Subnets[0].VpcId', '--output', 'text')
$shortName = $StackName.ToLower().Substring(0, [Math]::Min(12, $StackName.Length))
$bucket = "zspeed-$account-$shortName-$Region-deploy"
& aws s3api head-bucket --bucket $bucket --region $Region 2>$null
if ($LASTEXITCODE -ne 0) {
    $create = @('s3api', 'create-bucket', '--bucket', $bucket)
    if ($Region -ne 'us-east-1') { $create += @('--create-bucket-configuration', "LocationConstraint=$Region") }
    $null = Invoke-Aws $create
}
$null = Invoke-Aws @('s3api', 'put-public-access-block', '--bucket', $bucket, '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true')
$null = Invoke-Aws @('s3api', 'put-bucket-versioning', '--bucket', $bucket, '--versioning-configuration', 'Status=Enabled')
$key = "source-$([Guid]::NewGuid().ToString('N')).tar.gz"
$archive = Join-Path $PSScriptRoot "deployment-$key"
try {
    # Explicit roots and exclusions keep local databases, credentials and dependencies off AWS.
    & tar -czf $archive --exclude=node_modules --exclude=dist --exclude=data --exclude=.env --exclude='.env.*' --exclude=credentials.txt --exclude='*.db*' --exclude='*.log' --exclude='*.tsbuildinfo' backend frontend simulator-ui sample-data docker docker-compose.yml start.sh .dockerignore
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the project.' }
    $null = Invoke-Aws @('s3', 'cp', $archive, "s3://$bucket/$key", '--sse', 'AES256')
    Write-Host 'Creating billable AWS infrastructure and building the application. This can take several minutes.'
    $null = Invoke-Aws @('cloudformation', 'deploy', '--template-file', 'deploy/aws.yaml', '--stack-name', $StackName, '--capabilities', 'CAPABILITY_IAM', '--parameter-overrides', "VpcId=$vpc", "SubnetId=$SubnetId", "SourceBucket=$bucket", "SourceKey=$key", "Domain=$Domain", '--no-fail-on-empty-changeset')
    Invoke-Aws @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs', '--output', 'table')
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}
