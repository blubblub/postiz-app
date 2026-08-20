import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationRecordFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class ChannelAnalyticsTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'channelAnalytics';

  run() {
    return createTool({
      id: 'channelAnalytics',
      description: `Read a channel's analytics — followers, views, engagement and whatever else the platform reports. Each platform returns a different set of metrics, so treat the list as open-ended. Use integrationList for the channel id.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Channel id from the integrationList tool'),
        days: z
          .string()
          .optional()
          .describe('How many days back to report, e.g. "7" or "30"'),
      }),
      mcp: {
        annotations: {
          title: 'Channel Analytics',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      outputSchema: z.object({
        metrics: z.array(
          z.object({
            label: z.string().optional(),
            percentageChange: z.number().optional(),
            data: z.array(z.any()).optional(),
          })
        ),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organization = organizationRecordFromContext(context);

        const result: any = await this._integrationService.checkAnalytics(
          organization,
          inputData.integrationId,
          inputData.days || '7'
        );

        return {
          metrics: (Array.isArray(result) ? result : []).map((m: any) => ({
            label: m?.label,
            percentageChange: m?.percentageChange,
            data: m?.data,
          })),
        };
      },
    });
  }
}
