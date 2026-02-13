import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codestarconnections from 'aws-cdk-lib/aws-codestarconnections';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface InfraStackProps extends cdk.StackProps {
    environment: string;
}

export class InfraStack extends cdk.Stack {

    public constructor(scope: Construct, id: string, props: InfraStackProps) {
        super(scope, id, props);

        const environment = props.environment;

        // table
        const table = new dynamodb.Table(this, 'Table', {
            tableName: 'school-licenses-table',
            partitionKey: {
                name: 'PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'SK',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            deletionProtection: true,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        cdk.Tags.of(table).add('Environment', environment);
        cdk.Tags.of(table).add('Service', 'sle');
        cdk.Tags.of(table).add('stack', 'cdk-infra');


        // Infra Pipeline Resources
        this.createInfraPipeline(environment);

    }


    private createInfraPipeline(environment: string) {
        // Infra Pipeline S3 Buckets
        const infraArtifactBucket = new s3.Bucket(this, 'InfraArtifactBucket', {
            bucketName: `sle-${environment}-infra-artifacts`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const infraPackagingBucket = new s3.Bucket(this, 'InfraPackagingBucket', {
            bucketName: `sle-${environment}-packaging-bucket`,
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // GitHub Connection for Infra Pipeline
        const infraGitHubConnection = new codestarconnections.CfnConnection(this, 'InfraGitHubConnection', {
            connectionName: `sle-${environment}-git-infra-conn`,
            providerType: 'GitHub',
        });

        // CodeBuild Service Role for Infra
        const infraCodeBuildServiceRole = new iam.Role(this, 'InfraCodeBuildServiceRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });

        // Add policies to CodeBuild role
        infraCodeBuildServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams',
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/sle-${environment}-infra-codebuild*`,
            ],
        }));

        infraCodeBuildServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:GetObject',
                's3:PutObject',
                's3:GetObjectVersion',
                's3:ListBucket'
            ],
            resources: [
                infraArtifactBucket.bucketArn,
                `${infraArtifactBucket.bucketArn}/*`,
                infraPackagingBucket.bucketArn,
                `${infraPackagingBucket.bucketArn}/*`,
            ],
        }));

        infraCodeBuildServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudformation:ValidateTemplate', 'cloudformation:DescribeStacks', 'cloudformation:PackageType'],
            resources: ['*'],
        }));

        infraCodeBuildServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [`arn:aws:iam::${this.account}:role/sle-${environment}-*`],
        }));

        // CodeBuild Project for Infra
        const infraCodeBuildProject = new codebuild.PipelineProject(this, 'InfraCodeBuildProject', {
            projectName: `sle-${environment}-infra-codebuild`,
            description: 'SLE Infrastructure - CodeBuild',
            role: infraCodeBuildServiceRole,
            timeout: cdk.Duration.minutes(10),
            buildSpec: codebuild.BuildSpec.fromSourceFilename('pipeline/infra-buildspec.yaml'),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
                environmentVariables: {
                    PACKAGING_BUCKET: { value: infraPackagingBucket.bucketName },
                    ENVIRONMENT: { value: this.node.tryGetContext('environment') || environment },
                    PIPELINE_GITHUB_BRANCH: { value: this.node.tryGetContext('pipelineGithubBranch') || 'main' },
                },
            },
        });

        // CodePipeline Execution Role for Infra
        const infraCodePipelineExecutionRole = new iam.Role(this, 'InfraCodePipelineExecutionRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('codepipeline.amazonaws.com'),
                new iam.ServicePrincipal('cloudformation.amazonaws.com')
            ),
        });

        // Add extensive policies to CodePipeline role
        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'PipelineStackPermission',
            actions: [
                'cloudformation:CreateStack',
                'cloudformation:DeleteStack',
                'cloudformation:RollbackStack',
                'cloudformation:DescribeStacks',
                'cloudformation:UpdateStack',
                'cloudformation:SetStackPolicy',
                'cloudformation:GetStackPolicy',
                'cloudformation:GetTemplate',
                'cloudformation:ListStacks',
            ],
            resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/sle-${environment}-*`],
        }));

        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'PipelineChangeSetPermission',
            actions: [
                'cloudformation:ListChangeSets',
                'cloudformation:CreateChangeSet',
                'cloudformation:DescribeChangeSet',
                'cloudformation:ExecuteChangeSet',
                'cloudformation:DeleteChangeSet',
            ],
            resources: ['*'],
        }));

        // DynamoDB permissions
        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'DynamoDB',
            actions: [
                'dynamodb:CreateTable',
                'dynamodb:UpdateTable',
                'dynamodb:DescribeTable',
                'dynamodb:DeleteTable',
                'dynamodb:TagResource',
                'dynamodb:UntagResource',
                'dynamodb:UpdateContinuousBackups',
                'dynamodb:DescribeContinuousBackups',
            ],
            resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/school-licenses-table`],
        }));

        // S3 permissions
        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'S3ListPermissions',
            actions: [
                's3:ListBucket',
                's3:GetObjectVersion',
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
                's3:TagResource',
                's3:UntagResource',
                's3:ListTagsForResource',
                's3:PutBucketPublicAccessBlock',
            ],
            resources: [
                `arn:aws:s3:::sle-${environment}-*`,
                `arn:aws:s3:::sle-${environment}-*/*`,
            ],
        }));

        // Pipeline permissions
        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'codestar-connections:UseConnection',
                'codestar-connections:GetConnection',
            ],
            resources: [infraGitHubConnection.attrConnectionArn],
        }));

        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'codebuild:StartBuild',
                'codebuild:BatchGetBuilds',
            ],
            resources: [infraCodeBuildProject.projectArn],
        }));

        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ApplicationPipelinePermissions',
            actions: [
                'codeconnections:CreateConnection',
                'codeconnections:GetConnection',
                'codeconnections:DeleteConnection',
                'codeconnections:TagResource',
                'codeconnections:ListTagsForResource',
                'codestar-connections:PassConnection',
            ],
            resources: [`arn:aws:codestar-connections:${this.region}:${this.account}:*`],
        }));

        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'CodeBuildAccess',
            actions: [
                'codebuild:CreateProject',
                'codebuild:DeleteProject',
            ],
            resources: [`arn:aws:codebuild:${this.region}:${this.account}:project/sle-${environment}-*`],
        }));
        
        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'CodePipelineAccess',
            actions: [
                'codepipeline:CreatePipeline',
                'codepipeline:DeletePipeline',
                'codepipeline:TagResource',
                'codepipeline:UntagResource',
                'codepipeline:GetPipeline',
            ],
            resources: [`arn:aws:codepipeline:${this.region}:${this.account}:sle-${environment}-*`],
        }));

        infraCodePipelineExecutionRole.addToPolicy(new iam.PolicyStatement({
            sid: 'SSMParameterStoreAccess',
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
                'ssm:DeleteParameter',
            ],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap*`],
        }));

        // Infra Pipeline
        const infraSourceOutput = new codepipeline.Artifact();
        const infraBuildOutput = new codepipeline.Artifact();

        const infraPipeline = new codepipeline.Pipeline(this, 'InfraPipeline', {
            pipelineName: `sle-${environment}-infra-pipeline`,
            role: infraCodePipelineExecutionRole,
            artifactBucket: infraArtifactBucket,
            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        new codepipeline_actions.CodeStarConnectionsSourceAction({
                            actionName: 'GitHubSource',
                            owner: 'goelsnehaa',
                            repo: 'aws-cdk-infra',
                            connectionArn: infraGitHubConnection.attrConnectionArn,
                            branch: this.node.tryGetContext('pipelineGithubBranch') || 'main',
                            output: infraSourceOutput,
                            triggerOnPush: false,
                        }),
                    ],
                },
                {
                    stageName: 'Build',
                    actions: [
                        new codepipeline_actions.CodeBuildAction({
                            actionName: 'PackageTemplates',
                            project: infraCodeBuildProject,
                            input: infraSourceOutput,
                            outputs: [infraBuildOutput],
                        }),
                    ],
                },
                {
                    stageName: 'CreateChangeSet',
                    actions: [
                        new codepipeline_actions.CloudFormationCreateReplaceChangeSetAction({
                            actionName: 'CreateInfraChangeSet',
                            stackName: `sle-${environment}-infra-cf`,
                            changeSetName: `sle-${environment}-infra-changeset`,
                            adminPermissions: false,
                            deploymentRole: infraCodePipelineExecutionRole,  
                            templatePath: infraBuildOutput.atPath(`sle-infrastructure-${environment}.template.json`),
                            runOrder: 1,
                        }),
                    ],
                },
                {
                    stageName: 'Approve',
                    actions: [
                        new codepipeline_actions.ManualApprovalAction({
                            actionName: 'ManualApproval',
                            runOrder: 1,
                        }),
                    ],
                },
                {
                    stageName: 'ExecuteChangeSet',
                    actions: [
                        new codepipeline_actions.CloudFormationExecuteChangeSetAction({
                            actionName: 'ExecuteInfraChangeSet',
                            stackName: `sle-${environment}-infra-cf`,
                            changeSetName: `sle-${environment}-infra-changeset`,
                            runOrder: 1,
                        }),
                    ],
                },
            ],
        });

        // Outputs
        new cdk.CfnOutput(this, 'InfraCodeBuildIAMRole', {
            description: 'Infra CodeBuild IAM Role',
            value: infraCodeBuildServiceRole.roleArn,
        });

        new cdk.CfnOutput(this, 'InfraCodeBuild', {
            description: 'Infra CodeBuild Project name',
            value: infraCodeBuildProject.projectName,
        });

        new cdk.CfnOutput(this, 'InfraCodePipeline', {
            description: 'Infra AWS CodePipeline pipeline name',
            value: infraPipeline.pipelineName,
        });

        new cdk.CfnOutput(this, 'InfraCodePipelineIAMRole', {
            description: 'Infra CodePipeline IAM Role',
            value: infraCodePipelineExecutionRole.roleArn,
        });
    }
}