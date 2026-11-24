create extension if not exists pgmq;
select pgmq.create('rj_jobs');
