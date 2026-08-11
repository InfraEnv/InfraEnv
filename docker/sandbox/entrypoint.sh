#!/usr/bin/env bash
set -eu
printf '\n'
printf '  InfraEnv Ubuntu Learning Sandbox\n'
printf '  =================================\n'
printf '  SIMULATED / S2 — behavioral model, not real HPC performance\n'
printf '  This is a real Ubuntu shell. GPU, cluster, scheduler and metric state is simulated.\n'
printf '  Try: nvidia-smi, sinfo, squeue, infraenv nodes\n\n'
printf '  Commands are limited to this Scenario whitelist; no arbitrary cluster control is exposed.\n\n'
export PS1='\[\e[38;5;114m\][infraenv:S2]\[\e[0m\] \u@\h:\w$ '
exec /bin/bash --noprofile --norc -i
