import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class NotificationListTool implements AgentToolInterface {
  constructor(private _notificationService: NotificationService) {}
  name = 'notificationList';

  run() {
    return createTool({
      id: 'notificationList',
      description: `Read the workspace notifications — this is where failed posts and channels that need reconnecting are reported, so it is the quickest way to find out what is currently broken.`,
      inputSchema: z.object({
        page: z.number().optional().describe('Page number, starts at 0'),
      }),
      mcp: {
        annotations: {
          title: 'List Notifications',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      outputSchema: z.object({
        notifications: z.array(
          z.object({
            id: z.string().optional(),
            content: z.string().optional(),
            link: z.string().optional(),
            createdAt: z.string().optional(),
          })
        ),
        total: z.number().optional(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        const result: any =
          await this._notificationService.getNotificationsPaginated(
            organizationId,
            inputData.page ?? 0
          );

        return {
          notifications: (result?.notifications || []).map((n: any) => ({
            id: n.id,
            content: n.content,
            link: n.link || undefined,
            createdAt: n.createdAt
              ? new Date(n.createdAt).toISOString()
              : undefined,
          })),
          total: result?.total,
        };
      },
    });
  }
}
