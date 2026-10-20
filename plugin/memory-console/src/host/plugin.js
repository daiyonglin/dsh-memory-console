import { run } from './commands.js'
import { registerRpc } from './rpc.js'

export const name = 'memory-console'
export const inject = ['commands', 'tokenMeter', 'agents']

export function apply(ctx) {
  ctx.commands.register({
    definitionId: 'memory-console:mem',
    name: 'mem',
    description: '记忆控制台：按任务阶段查看、预览、收起、移出并恢复上下文',
    input: { hint: '[report | dryrun <n> | fold <n> --yes | remove <n> --yes | restore <id> | status | diag]' },
    handler: (invocation) => run(ctx, invocation),
  })
  registerRpc(ctx)
}
