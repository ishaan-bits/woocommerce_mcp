-- Milestone 11 Phase 2 (requirement matrix X3/X4): additive demo grants so
-- the two-user DoD story can reach multiple upstreams and self-serve a key.
-- Update-only, keyed on the two seed users from 001_init.sql — no rows are
-- inserted, deleted or reset, and running it twice is a no-op.
--
-- admin-demo already has all three upstreams; it is missing the inventory and
-- support tools. reader-demo is missing the inventory and support upstreams
-- and their read-only tools (writes stay admin-only). Grant strings are the
-- qualified `tools:<name>` form, matching what the gateways' C5 checks expect.

UPDATE users
   SET allowed_tools = (
     SELECT array_agg(DISTINCT tool ORDER BY tool)
       FROM unnest(
         allowed_tools || ARRAY[
           'tools:inventory_list_products',
           'tools:inventory_adjust_stock',
           'tools:support_list_tickets',
           'tools:support_create_ticket'
         ]
       ) AS tool
   )
 WHERE id = '11111111-1111-4111-8111-111111111111';

UPDATE users
   SET allowed_upstreams = (
     SELECT array_agg(DISTINCT upstream ORDER BY upstream)
       FROM unnest(
         allowed_upstreams || ARRAY['inventory', 'support']
       ) AS upstream
   ),
       allowed_tools = (
     SELECT array_agg(DISTINCT tool ORDER BY tool)
       FROM unnest(
         allowed_tools || ARRAY[
           'tools:inventory_list_products',
           'tools:support_list_tickets'
         ]
       ) AS tool
   )
 WHERE id = '22222222-2222-4222-8222-222222222222';
