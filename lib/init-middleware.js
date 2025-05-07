export default function initMiddleware(middleware) {
    return (req, res) =>
        new Promise((resolve, reject) => {
            middleware(req, res, (result) => {
                return result instanceof Error ? reject(result) : resolve(result);
            });
        });
}
