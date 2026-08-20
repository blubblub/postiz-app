import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

const replySchema = z.object({
  id: z.string(),
  text: z.string(),
  username: z.string().optional(),
  timestamp: z.string().optional(),
  likeCount: z.number().optional(),
  hidden: z.boolean().optional(),
});

@Injectable()
export class CommentListTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'commentList';

  run() {
    return createTool({
      id: 'commentList',
      description: `Read the comments on a published post, including one level of replies. Use commentPostList first to get the post id. \`hidden\` tells you whether a comment is already hidden from the public.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Channel id from the integrationList tool'),
        postId: z.string().describe('Post id from the commentPostList tool'),
        cursor: z
          .string()
          .optional()
          .describe(
            'The `next` value from a previous call, to get more comments'
          ),
      }),
      mcp: {
        annotations: {
          title: 'Read Comments',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      outputSchema: z.object({
        comments: z.array(
          replySchema.extend({ replies: z.array(replySchema).optional() })
        ),
        next: z.string().optional(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        const page = await this._integrationService.fetchPostComments(
          organizationId,
          inputData.integrationId,
          inputData.postId,
          inputData.cursor
        );

        const clean = (comment: any) => ({
          id: comment.id,
          text: comment.text,
          username: comment.username,
          timestamp: comment.timestamp,
          likeCount: comment.likeCount,
          hidden: comment.hidden,
        });

        return {
          comments: (page.comments || []).map((comment) => ({
            ...clean(comment),
            replies: (comment.replies || []).map(clean),
          })),
          next: page.next,
        };
      },
    });
  }
}
