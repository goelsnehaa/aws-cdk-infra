#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {InfraStack} from './index';

const app = new cdk.App();

// Get parameters from context or environment
const environment = app.node.tryGetContext('environment') || 'dev';

new InfraStack(app, `sle-infrastructure-${environment}`, {
  environment,
})