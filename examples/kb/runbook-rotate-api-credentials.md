---
slug: runbook-rotate-api-credentials
title: Runbook - rotate the API credentials of an organization
lang: en
kind: runbook
visibility: internal
tags: api_error, account_access
---
# Runbook: rotate the API credentials of an organization

Use this when a customer reports that their credentials were exposed, or when a scheduled rotation is due. This is an example procedure for the demo data: replace it with your own.

## Before you start

- Confirm who is asking. Rotation is only done for an administrator of the organization, verified through the contact on file.
- Tell the customer that the old credentials stop working at once, and agree the time.

## Steps

1. Open the organization in the admin console and choose **Credentials**.
2. Create a new credential and copy it into the secure channel the customer agreed to. Never paste it into a ticket.
3. Ask the customer to switch their system to the new credential.
4. When they confirm, revoke the old credential.
5. Add an internal note to the ticket with the time of the rotation and who confirmed it.

## Afterwards

Watch the error rate of the organization for 30 minutes. A burst of authentication errors means a system still uses the old credential.
