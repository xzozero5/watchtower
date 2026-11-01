---
slug: webhook-not-received
title: Your webhook endpoint does not receive events
lang: en
visibility: customer
tags: webhook_not_received
---
# Your webhook endpoint does not receive events

Events are sent as HTTPS POST requests to the endpoint you registered. If your system sees nothing, work through this list from the top.

## Check the endpoint

- The address must be reachable from the public internet over HTTPS with a valid certificate. Addresses on a private network are not reachable.
- Answer with a 2xx status within 10 seconds. Do the heavy work after answering.
- A firewall or gateway that blocks unknown sources will reject us. Allow the source ranges listed in your account settings.

## Check the delivery log

Open the delivery log in your account settings. Each attempt shows the status your endpoint returned and when it was tried.

- **No attempts listed**: the event type is not enabled for this endpoint. Enable it and trigger a test event.
- **Timeouts**: your endpoint answered too slowly. Answer first, process later.
- **4xx or 5xx statuses**: your endpoint refused the request. Check its own logs for the reason.

## Retries

Failed deliveries are retried with growing pauses for up to 24 hours. After that the event is kept in the delivery log, and you can send it again by hand.
