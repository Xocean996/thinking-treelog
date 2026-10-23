# Plan auditing design

## Context

- Teams write superpowers plans, but interface drift is caught by hand
- A plan already declares which symbol each task consumes and produces

## Decision

Decision: Parse the plan document and extract tasks, steps and interface declarations.
Decision: Build an interface graph from the Consumes and Produces declarations, and report symbols consumed but never produced.
Decision: Render the findings in a form a human can read and CI can fail on.
Decision: Capture the current conversation directly so nobody has to paste.

## Consequences

- Must follow the superpowers plan format
