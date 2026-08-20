import * as p from "@clack/prompts";

type SetupSpinner = Pick<ReturnType<typeof p.spinner>, "error" | "start" | "stop">;

type SpinnerTaskOptions<Result> = {
  failure: string;
  run: () => Promise<Result>;
  spinner?: SetupSpinner;
  start: string;
  success: string | ((result: Result) => string);
};

/** Run one setup step while guaranteeing that its animated spinner is terminated. */
export async function withSpinner<Result>(options: SpinnerTaskOptions<Result>): Promise<Result> {
  const spinner = options.spinner ?? p.spinner();
  spinner.start(options.start);

  try {
    const result = await options.run();
    spinner.stop(typeof options.success === "function" ? options.success(result) : options.success);
    return result;
  } catch (error) {
    spinner.error(options.failure);
    throw error;
  }
}
