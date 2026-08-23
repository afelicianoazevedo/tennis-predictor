CREATE POLICY "Allow public read access to match_prediction_factors"
ON public.match_prediction_factors
FOR SELECT
TO anon
USING (true);
