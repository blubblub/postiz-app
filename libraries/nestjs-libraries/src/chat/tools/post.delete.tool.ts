import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class PostDeleteTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'postDelete';

  run() {
    return createTool({
      id: 'postDelete',
      description: `Delete a post. This removes the whole group the post belongs to, so a post published to several channels together is deleted from all of them. It cannot be undone — confirm with the user first. Use postList to find the id.`,
      inputSchema: z.object({
        postId: z.string().describe('Post id from the postList tool'),
      }),
      mcp: {
        annotations: {
          title: 'Delete A Post',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      outputSchema: z.object({
        deleted: z.boolean(),
        group: z.string().optional(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        const post = await this._postsService.getPost(
          organizationId,
          inputData.postId
        );

        if (!post) {
          return { deleted: false };
        }

        await this._postsService.deletePost(organizationId, post.group);
        return { deleted: true, group: post.group };
      },
    });
  }
}
